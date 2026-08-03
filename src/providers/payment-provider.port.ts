import { Decimal } from '../shared';

export type CreateChargeInput = {
  valor: Decimal;
  idTransacaoPrivado: string;
  idTransacaoPublico: string;
  referenciaExterna?: string;
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
