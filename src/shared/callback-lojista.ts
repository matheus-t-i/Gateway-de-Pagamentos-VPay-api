/**
 * CONTRATO PÚBLICO DO CALLBACK AO LOJISTA.
 *
 * O `status` enviado é a SITUAÇÃO DO SISTEMA (`SITUACAO_TRANSACAO`) — o mesmo
 * vocabulário que aparece no painel, nos relatórios e na consulta da API. Não
 * existe tradução: o que o lojista lê no callback é o que ele vê na tela.
 *
 * ⚠️ Isto é API pública: o lojista escreve `if (status === 'CONCLUIDA')` do lado
 * dele. Renomear ou ressignificar um valor QUEBRA integrações em produção
 * silenciosamente — o webhook continua entregando 200, só deixa de casar com o
 * `if`. Só se acrescenta valor novo.
 */

import { SITUACAO_TRANSACAO } from './situacoes';

/** `operacao` do callback — o sentido do dinheiro. */
export const OPERACAO_CALLBACK = {
  CASH_IN: 'cash_in',
  CASH_OUT: 'cash_out',
} as const;
export type OperacaoCallback =
  (typeof OPERACAO_CALLBACK)[keyof typeof OPERACAO_CALLBACK];

/**
 * Situações que o CASH-IN realmente assume. A cobrança já nasce
 * `AGUARDANDO_PAGAMENTO` — não passa por `PENDENTE`/`PROCESSANDO` — e não é
 * cancelada: quando a geração não vai adiante em nenhuma liquidante, é `FALHA`.
 */
export const STATUS_CASH_IN = [
  SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
  SITUACAO_TRANSACAO.CONCLUIDA,
  SITUACAO_TRANSACAO.FALHA,
  SITUACAO_TRANSACAO.MED,
] as const;

/**
 * Situações que o CASH-OUT realmente assume. `PROCESSANDO` é o estado em que o
 * saldo JÁ está debitado e o saque está com a liquidante.
 *
 * `CANCELADA` saiu da lista: nenhum ponto do código cancela um saque, e um
 * status que o lojista nunca recebe é pior que ausência de status — ele escreve
 * um `if` que nunca executa e acredita estar coberto. Se um dia existir
 * cancelamento, o valor volta para cá junto com quem o emite.
 */
export const STATUS_CASH_OUT = [
  SITUACAO_TRANSACAO.PROCESSANDO,
  SITUACAO_TRANSACAO.CONCLUIDA,
  SITUACAO_TRANSACAO.FALHA,
] as const;

export type StatusCallback =
  | (typeof STATUS_CASH_IN)[number]
  | (typeof STATUS_CASH_OUT)[number];

/**
 * Situação interna → `status` do callback.
 *
 * Quase sempre é identidade. Os mapas existem para os estados que o fluxo não
 * expõe: `LIQUIDADA` é um passo intermediário do crédito (a venda vira
 * `CONCLUIDA` no mesmo job) e `PENDENTE` é só o default da coluna. Nenhum dos
 * dois pode vazar para o lojista como status "novo".
 */
const MAPA_CASH_IN: Record<string, StatusCallback> = {
  [SITUACAO_TRANSACAO.PENDENTE]: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
  [SITUACAO_TRANSACAO.PROCESSANDO]: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
  [SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO]: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
  [SITUACAO_TRANSACAO.LIQUIDADA]: SITUACAO_TRANSACAO.CONCLUIDA,
  [SITUACAO_TRANSACAO.CONCLUIDA]: SITUACAO_TRANSACAO.CONCLUIDA,
  [SITUACAO_TRANSACAO.FALHA]: SITUACAO_TRANSACAO.FALHA,
  // Cash-in não cancela: o que não foi gerado é falha.
  [SITUACAO_TRANSACAO.CANCELADA]: SITUACAO_TRANSACAO.FALHA,
  [SITUACAO_TRANSACAO.MED]: SITUACAO_TRANSACAO.MED,
};

const MAPA_CASH_OUT: Record<string, StatusCallback> = {
  [SITUACAO_TRANSACAO.PENDENTE]: SITUACAO_TRANSACAO.PROCESSANDO,
  [SITUACAO_TRANSACAO.PROCESSANDO]: SITUACAO_TRANSACAO.PROCESSANDO,
  // Não há pagador num saque; se aparecer, ainda está em andamento.
  [SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO]: SITUACAO_TRANSACAO.PROCESSANDO,
  [SITUACAO_TRANSACAO.LIQUIDADA]: SITUACAO_TRANSACAO.CONCLUIDA,
  [SITUACAO_TRANSACAO.CONCLUIDA]: SITUACAO_TRANSACAO.CONCLUIDA,
  [SITUACAO_TRANSACAO.FALHA]: SITUACAO_TRANSACAO.FALHA,
  // Saque não é cancelado por nenhum fluxo hoje; se a situação aparecer no
  // banco, o lojista precisa entender como "não vai adiante".
  [SITUACAO_TRANSACAO.CANCELADA]: SITUACAO_TRANSACAO.FALHA,
  // Devolução é conceito de MED (cash-in); num saque, tratar como falha.
  [SITUACAO_TRANSACAO.MED]: SITUACAO_TRANSACAO.FALHA,
};

export function statusCallback(
  situacao: string,
  direcao: 'ENTRADA' | 'SAIDA',
): StatusCallback {
  if (direcao === 'ENTRADA') {
    return MAPA_CASH_IN[situacao] ?? SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
  }
  return MAPA_CASH_OUT[situacao] ?? SITUACAO_TRANSACAO.PROCESSANDO;
}

export function operacaoCallback(direcao: 'ENTRADA' | 'SAIDA'): OperacaoCallback {
  return direcao === 'ENTRADA'
    ? OPERACAO_CALLBACK.CASH_IN
    : OPERACAO_CALLBACK.CASH_OUT;
}

/**
 * Reenvio manual só onde EXISTE evento de outbox (`EVENTOS_LOJISTA`):
 * - cash-in: `CONCLUIDA` (`pix.cashin.pago`) e `MED` (`pix.devolucao.concluida`)
 * - cash-out: `CONCLUIDA` (`pix.cashout.concluido`) e `FALHA` (`pix.cashout.falhou`)
 *
 * `AGUARDANDO_PAGAMENTO` / `PROCESSANDO` não são finais e não geram callback.
 * `FALHA` de cash-in também não: a cobrança morreu na geração, sem outbox.
 */
export function podeReenviarCallback(
  situacao: string,
  direcao: 'ENTRADA' | 'SAIDA',
): boolean {
  if (direcao === 'ENTRADA') {
    return (
      situacao === SITUACAO_TRANSACAO.CONCLUIDA ||
      situacao === SITUACAO_TRANSACAO.LIQUIDADA ||
      situacao === SITUACAO_TRANSACAO.MED
    );
  }
  return (
    situacao === SITUACAO_TRANSACAO.CONCLUIDA ||
    situacao === SITUACAO_TRANSACAO.LIQUIDADA ||
    situacao === SITUACAO_TRANSACAO.FALHA
  );
}

/**
 * Documentação viva: o que a tela de documentação lista para o lojista tratar.
 * Mesma informação dos mapas acima — sair de sincronia faz o cliente tratar um
 * status que nunca chega (ou deixar de tratar um que chega).
 */
export const STATUS_CALLBACK_DOC: Array<{
  status: StatusCallback;
  operacoes: OperacaoCallback[];
  descricao: string;
  terminal: boolean;
}> = [
  {
    status: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
    operacoes: [OPERACAO_CALLBACK.CASH_IN],
    descricao:
      'Cobrança criada com código PIX válido, aguardando o pagador. É o estado inicial de toda venda.',
    terminal: false,
  },
  {
    status: SITUACAO_TRANSACAO.PROCESSANDO,
    operacoes: [OPERACAO_CALLBACK.CASH_OUT],
    descricao:
      'Saque com o saldo já debitado e a ordem enviada à liquidante, aguardando confirmação.',
    terminal: false,
  },
  {
    status: SITUACAO_TRANSACAO.CONCLUIDA,
    operacoes: [OPERACAO_CALLBACK.CASH_IN, OPERACAO_CALLBACK.CASH_OUT],
    descricao:
      'Cash-in: pago e creditado na carteira — é o gatilho para liberar o pedido. Cash-out: saque liquidado para o beneficiário.',
    terminal: true,
  },
  {
    status: SITUACAO_TRANSACAO.FALHA,
    operacoes: [OPERACAO_CALLBACK.CASH_IN, OPERACAO_CALLBACK.CASH_OUT],
    descricao:
      'A operação não vai adiante. No cash-in, nenhuma liquidante conseguiu gerar a cobrança nem pela contingência. No cash-out, a liquidante recusou a ordem — o valor já debitado NÃO volta sozinho: fale com o suporte para o estorno.',
    terminal: true,
  },
  {
    status: SITUACAO_TRANSACAO.MED,
    operacoes: [OPERACAO_CALLBACK.CASH_IN],
    descricao:
      'Venda devolvida ao pagador (MED aceito). Chega com `data_med` preenchida — estorne o pedido.',
    terminal: true,
  },
];
