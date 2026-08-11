import { Decimal } from '../shared';

/**
 * A liquidante RECUSOU a ordem — resposta explícita, não dúvida.
 *
 * Existe para separar os dois desfechos ruins de um saque, que exigem
 * tratamentos opostos:
 *
 * - **Recusa** (4xx: chave inexistente no DICT, documento que não bate, dado
 *   inválido): a ordem NÃO foi aceita, então nada foi pago. É seguro encerrar a
 *   transação como `FALHA` e avisar o lojista. Retentar só repete o mesmo erro.
 * - **Ambiguidade** (timeout, 5xx, queda de rede): não sabemos se o dinheiro
 *   saiu. Aqui o fluxo CONGELA para reconciliação manual — nunca se retenta
 *   automaticamente, sob risco de pagar duas vezes.
 *
 * Só lance isto quando a liquidante disse "não" de forma inequívoca.
 */
export class RecusaAdquirenteError extends Error {
  constructor(
    message: string,
    readonly detalhe: { statusHttp?: number; dadosResposta?: unknown } = {},
  ) {
    super(message);
    this.name = 'RecusaAdquirenteError';
  }
}

/**
 * A ordem NÃO chegou a ser transmitida — falhou antes do POST que move dinheiro.
 *
 * Casos típicos: autenticação na liquidante (credencial nossa rotacionada),
 * credencial ausente, erro montando o payload. Nada saiu, então **retentar é
 * seguro** — e é importante que seja, porque o oposto (congelar) deixaria todos
 * os saques presos por um problema de configuração nosso.
 *
 * É o contraponto do erro AMBÍGUO: se a falha aconteceu depois do POST, não se
 * sabe se o dinheiro saiu, e aí o fluxo congela em vez de retentar.
 */
export class ErroAntesDoEnvioError extends Error {
  constructor(
    message: string,
    readonly causa?: unknown,
  ) {
    super(message);
    this.name = 'ErroAntesDoEnvioError';
  }
}

export type CreateChargeInput = {
  valor: Decimal;
  idTransacaoPrivado: string;
  idTransacaoPublico: string;
  /**
   * ⚠️ A `referenciaExterna` do lojista NÃO entra aqui, de propósito. Ela é o id
   * do sistema DELE — etiqueta, opcional, repetível — e não pode virar chave de
   * correlação com a liquidante: como cobrança nunca responde 409, a mesma
   * referência acumula N cobranças, e mandá-la para a adquirente produzia duas
   * cobranças com o mesmo `external_reference` (a chave do refund, que não tem
   * idempotência). Adquirente nova correlaciona por `idTransacaoPublico`.
   */
  pagador?: {
    nome?: string;
    documento?: string;
    email?: string;
    telefone?: string;
    /** Entrega — presente quando a venda tem item tangível. */
    endereco?: Record<string, unknown>;
  };
  /** Itens da venda. Adquirentes que fazem antifraude usam isso. */
  itens?: Array<{
    titulo: string;
    quantidade: number;
    valorUnitario: number;
    tangivel: boolean;
  }>;
  expiracaoSegundos?: number;
  credenciais: Record<string, unknown>;
  /**
   * Abort da contingência: quando o timeout estoura, o fetch em voo é
   * cancelado para reduzir cobrança fantasma na adquirente A.
   */
  signal?: AbortSignal;
};

export type CreateChargeResult = {
  idTransacaoLiquidante: string;
  txid?: string;
  pixCopiaCola: string;
  urlCheckout?: string;
  expiraEm?: Date;
  raw: unknown;
};

export type CreateCashOutInput = {
  valor: Decimal;
  idTransacaoPrivado: string;
  chavePix: string;
  tipoChavePix: string;
  nomeBeneficiario?: string;
  documentoBeneficiario?: string;
  credenciais: Record<string, unknown>;
};

export type CreateCashOutResult = {
  idTransacaoLiquidante: string;
  raw: unknown;
};

export type ProviderStatus =
  | 'PENDING'
  | 'WAITING_PAYMENT'
  | 'PAID'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED';

export type GetStatusResult = {
  status: ProviderStatus;
  /** Valor confirmado na liquidante (quando a API devolve). Camada 1 confere vs valorBruto. */
  valor?: Decimal;
  endToEndId?: string;
  paidAt?: Date;
  raw: unknown;
};

export type CreateRefundInput = {
  valor: Decimal;
  idTransacaoLiquidante: string;
  idTransacaoPrivado: string;
  idDevolucaoPublico: string;
  motivo?: string;
  credenciais: Record<string, unknown>;
};

export type CreateRefundResult = {
  identificadorDevolucaoProvedor: string;
  raw: unknown;
};

/**
 * Saldo da NOSSA conta na adquirente (tesouraria) — não tem relação com o
 * ledger do lojista. É o que sobra lá e alimenta os gatilhos de saque.
 */
export type GetBalanceResult = {
  disponivel: Decimal;
  bloqueado: Decimal;
  moeda: string;
  raw: unknown;
};

export type VerifyTransportInput = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  allowedIps: string[];
  exigeAssinatura: boolean;
  segredoWebhookHash?: string | null;
  webhookKeyEnv?: string;
};

export interface PaymentProviderPort {
  readonly code: string;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  createCashOut(input: CreateCashOutInput): Promise<CreateCashOutResult>;
  /** Devolução (total ou parcial) de um cash-in já liquidado — usada pelo MED. */
  createRefund(input: CreateRefundInput): Promise<CreateRefundResult>;
  getStatus(params: {
    idTransacaoLiquidante?: string;
    idTransacaoPrivado: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetStatusResult>;
  /** Saldo da nossa conta na adquirente — base dos gatilhos de saque. */
  getBalance(params: {
    contaProvedorId: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetBalanceResult>;
  verifyTransport(input: VerifyTransportInput): Promise<boolean>;
}
