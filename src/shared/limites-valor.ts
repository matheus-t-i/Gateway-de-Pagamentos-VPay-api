import { Decimal } from 'decimal.js';
import { money } from './money';

/**
 * Limite de valor por operação (ticket) — a recusa TEM que dizer o que é
 * permitido.
 *
 * Antes, valor fora da faixa respondia "Valor fora do ticket permitido" no
 * cash-in e "Valor abaixo do mínimo" no cash-out: o cliente não descobria nem
 * qual é a faixa nem para que lado errou, e a única saída era abrir chamado.
 * O texto é montado aqui, uma vez, e serve painel e API — as duas entradas
 * passam pelo `PixService`, então divergir seria só questão de tempo.
 */

/**
 * `1234.5` → `"R$ 1.234,50"`.
 *
 * Formatação manual de propósito: `toLocaleString('pt-BR')` depende do ICU do
 * runtime, e um container sem ICU completo devolveria "R$ 1,234.50" dentro da
 * mensagem de erro — justamente o texto que precisa ser inequívoco.
 */
export function formatarBRL(valor: Decimal | string | number): string {
  const d = money(valor instanceof Decimal ? valor.toString() : valor);
  const [inteiro, centavos] = d.abs().toFixed(2).split('.');
  const comMilhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${d.isNegative() ? '-' : ''}R$ ${comMilhar},${centavos}`;
}

export const OPERACAO_LIMITE = {
  COBRANCA: 'cobranca',
  SAQUE: 'saque',
} as const;

export type OperacaoLimite =
  (typeof OPERACAO_LIMITE)[keyof typeof OPERACAO_LIMITE];

/** `maximo: null` = sem teto (o cash-out permite conta sem limite superior). */
export type FaixaValor = {
  minimo: Decimal;
  maximo: Decimal | null;
};

const ROTULO: Record<OperacaoLimite, { nome: string; unidade: string }> = {
  [OPERACAO_LIMITE.COBRANCA]: { nome: 'cobrança PIX', unidade: 'por cobrança' },
  [OPERACAO_LIMITE.SAQUE]: { nome: 'saque PIX', unidade: 'por saque' },
};

/** "de R$ 1,00 a R$ 5.000,00 por cobrança" — ou, sem teto, "a partir de …". */
export function faixaPermitidaTexto(
  faixa: FaixaValor,
  operacao: OperacaoLimite,
): string {
  const { unidade } = ROTULO[operacao];
  return faixa.maximo
    ? `de ${formatarBRL(faixa.minimo)} a ${formatarBRL(faixa.maximo)} ${unidade}`
    : `a partir de ${formatarBRL(faixa.minimo)} ${unidade}`;
}

/**
 * Corpo da recusa. Vai inteiro no `BadRequestException`, então o painel lê o
 * `message` (é o que o `api()` do web extrai) e quem integra pela API tem os
 * números soltos para tratar sem regex na frase.
 */
export type RecusaLimiteValor = {
  message: string;
  erro: 'VALOR_FORA_DO_LIMITE';
  operacao: OperacaoLimite;
  valorInformado: string;
  valorMinimo: string;
  valorMaximo: string | null;
};

/**
 * `null` = valor aceito. Qualquer outra coisa é a recusa pronta para virar
 * `BadRequestException`.
 */
export function checarLimiteValor(
  valor: Decimal,
  faixa: FaixaValor,
  operacao: OperacaoLimite,
): RecusaLimiteValor | null {
  const abaixo = valor.lt(faixa.minimo);
  const acima = !!faixa.maximo && valor.gt(faixa.maximo);
  if (!abaixo && !acima) return null;

  const { nome } = ROTULO[operacao];
  const lado = abaixo ? 'menor que o mínimo' : 'maior que o máximo';
  return {
    message:
      `O valor ${formatarBRL(valor)} é ${lado} permitido para ${nome}. ` +
      `Aceitamos ${faixaPermitidaTexto(faixa, operacao)}.`,
    erro: 'VALOR_FORA_DO_LIMITE',
    operacao,
    valorInformado: valor.toFixed(2),
    valorMinimo: faixa.minimo.toFixed(2),
    valorMaximo: faixa.maximo ? faixa.maximo.toFixed(2) : null,
  };
}
