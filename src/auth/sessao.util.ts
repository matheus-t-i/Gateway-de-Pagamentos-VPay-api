/**
 * Duração e teto da sessão do painel (lado servidor).
 *
 * A regra de QUANDO renovar é compartilhada com o painel em
 * `src/shared/sessao-painel.ts`; o que está aqui é decisão de infraestrutura
 * desta API e nunca sai no token.
 */

/**
 * Teto ABSOLUTO da sessão, em horas, contado do LOGIN — não do último token.
 *
 * Renovação silenciosa sem teto transforma "sessão de 1h" em "sessão eterna
 * enquanto a aba estiver aberta": num painel que movimenta dinheiro, um
 * notebook esquecido aberto continuaria autenticado por dias. Passado o teto,
 * é login de novo — com senha e 2FA. `SESSAO_PAINEL_MAX_HORAS=0` desliga o
 * teto (decisão do dono do produto, não default).
 */
export const TETO_SESSAO_HORAS_PADRAO = 12;

const HORA_MS = 60 * 60 * 1000;

/** Teto da sessão em ms. `0` = sem teto. */
export function tetoSessaoMs(bruto = process.env.SESSAO_PAINEL_MAX_HORAS): number {
  const texto = bruto?.trim();
  if (!texto) return TETO_SESSAO_HORAS_PADRAO * HORA_MS;
  const horas = Number(texto);
  // Valor inválido não vira "sem teto" por acidente: cai no padrão.
  if (!Number.isFinite(horas) || horas < 0) return TETO_SESSAO_HORAS_PADRAO * HORA_MS;
  return Math.round(horas * HORA_MS);
}

/**
 * Converte `JWT_EXPIRES_IN` ('1h', '45m', '3600') em segundos.
 *
 * A renovação precisa do número para comparar com o que sobra do teto da
 * sessão e encurtar o último token — daí a leitura própria, em vez de repassar
 * a string para o `expiresIn` do jsonwebtoken. Cobre só o subconjunto que a
 * configuração usa; formato desconhecido cai no padrão em vez de explodir a
 * renovação de todo mundo.
 */
export function segundosDaDuracao(
  bruto: string | undefined,
  padraoSegundos = 3600,
): number {
  const texto = bruto?.trim();
  if (!texto) return padraoSegundos;
  const casou = /^(\d+)\s*(s|m|h|d)?$/i.exec(texto);
  if (!casou) return padraoSegundos;
  const fatores: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const segundos = Number(casou[1]) * fatores[(casou[2] ?? 's').toLowerCase()];
  return segundos > 0 ? segundos : padraoSegundos;
}
