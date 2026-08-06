import { ParametrosRastreio, StatusRemotoPedido } from '../shared';

/**
 * A venda em formato NEUTRO, do jeito que o gateway a conhece.
 *
 * Cada client de app traduz isto para o contrato de destino. O objetivo é que
 * app novo signifique um client novo — e não mexer em quem carrega a venda do
 * banco nem nos ganchos que disparam o envio.
 */
export type PedidoVenda = {
  /** `idTransacaoPublico` — vira o id do pedido no app e NUNCA muda. */
  idPedido: string;
  /** O id do lado do lojista, quando ele mandou. */
  referenciaExterna: string | null;
  /** Criação da cobrança. Imutável entre as atualizações do mesmo pedido. */
  criadoEm: Date;
  /** Quando o dinheiro entrou (`concluidoEm ?? liquidadoEm`). */
  pagoEm: Date | null;
  /** Quando a venda foi devolvida (MED). */
  devolvidoEm: Date | null;
  cliente: {
    nome: string | null;
    email: string | null;
    telefone: string | null;
    documento: string | null;
  };
  itens: Array<{
    id: string;
    titulo: string;
    quantidade: number;
    /** Valor unitário em CENTAVOS. */
    valorUnitarioCentavos: number;
  }>;
  /** Valor bruto da venda, em centavos. */
  valorBrutoCentavos: number;
  /** Tarifa da VPay, em centavos. */
  tarifaCentavos: number;
  /** O que sobrou para o lojista, em centavos. */
  liquidoLojistaCentavos: number;
  rastreio: ParametrosRastreio;
};

/**
 * O que o client precisa saber para fazer um envio.
 *
 * Tipo NEUTRO de propósito: é a assinatura que o dispatcher
 * (`IntegracoesService.enviarPara`) usa para falar com qualquer app. Derivar
 * isto de um client concreto faria o `switch` parar de compilar assim que dois
 * apps divergissem — que é exatamente o que acontece entre Utmify e Xtracky.
 */
export type EnvioApp = {
  /**
   * Credencial do app (Utmify: `x-api-token`), ou `null` quando o app não tem
   * nenhuma (Xtracky). Client que exige credencial checa e recusa; client que
   * não usa simplesmente ignora.
   */
  token: string | null;
  pedido: PedidoVenda;
  status: StatusRemotoPedido;
  /**
   * Envia como teste: o app valida o payload e não grava o pedido.
   * Ignorado por app sem suporte a teste (`AppIntegracao.suportaTeste`).
   */
  teste: boolean;
};

export type ResultadoEnvio = {
  statusHttp: number;
  corpoResposta: string;
  latenciaMs: number;
  /**
   * O app aceitou a chamada mas DESCARTOU o pedido (ex.: `duplicate: true` da
   * Xtracky). Não é erro — retentar não muda nada —, mas também não é "chegou":
   * a tela mostra como aviso para o lojista não achar que a venda foi
   * contabilizada.
   */
  avisoDescartado?: string;
};

/**
 * Falha de envio a um app.
 *
 * `definitivo` decide entre retentar e desistir: payload recusado, credencial
 * inválida ou janela de tempo do app expirada não melhoram com retentativa —
 * repetir só queima fila e esconde o erro real do lojista. Timeout, 5xx e queda
 * de rede são retentáveis.
 */
export class ErroEnvioIntegracao extends Error {
  constructor(
    message: string,
    readonly definitivo: boolean,
    readonly statusHttp?: number,
    readonly corpoResposta?: string,
    readonly latenciaMs?: number,
  ) {
    super(message);
    this.name = 'ErroEnvioIntegracao';
  }
}
