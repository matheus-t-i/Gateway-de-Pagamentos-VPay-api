import {
  deBrasilia,
  inicioDoDiaBrasilia,
  money,
  moneyToString,
  partesBrasilia,
  SITUACAO_TRANSACAO,
} from '../shared';

export { deBrasilia, partesBrasilia };

/** Situações que entram na série "Pagas" (dinheiro que entrou). */
export const SITUACOES_APROVADAS_SERIE: readonly string[] = [
  SITUACAO_TRANSACAO.LIQUIDADA,
  SITUACAO_TRANSACAO.CONCLUIDA,
];

export const INTERVALOS_SERIE_24H = {
  '1h': 60,
  '30m': 30,
  '15m': 15,
} as const;

export type IntervaloSerie24h = keyof typeof INTERVALOS_SERIE_24H;

export type PontoSerieDashboard = {
  ts: string;
  label: string;
  geradas: string;
  aprovadas: string;
  pendentes: string;
};

export type LinhaSerieDashboard = {
  criadoEm: Date;
  valorBruto: { toString(): string } | string | number;
  situacao: string;
};

export function resolverIntervaloSerie(raw?: string): IntervaloSerie24h {
  if (raw === '30m' || raw === '15m' || raw === '1h') return raw;
  return '1h';
}

function alinharBalde(d: Date, minutos: number): Date {
  const p = partesBrasilia(d);
  const min = Math.floor(p.minute / minutos) * minutos;
  return deBrasilia(p.year, p.month, p.day, p.hour, min);
}

function rotuloPorHora(d: Date, minutos: number): string {
  const p = partesBrasilia(d);
  const hh = String(p.hour).padStart(2, '0');
  if (minutos >= 60) return `${hh}h`;
  return `${hh}:${String(p.minute).padStart(2, '0')}`;
}

function rotuloDia(d: Date): string {
  const p = partesBrasilia(d);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}`;
}

function gerarBaldesPorMinuto(ate: Date, minutos: number): Date[] {
  const n = (24 * 60) / minutos;
  const ultimo = alinharBalde(ate, minutos);
  const ms = minutos * 60 * 1000;
  const primeiro = ultimo.getTime() - (n - 1) * ms;
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(primeiro + i * ms));
  }
  return out;
}

function gerarBaldesDiarios(desde: Date, ate: Date): Date[] {
  const primeiro = inicioDoDiaBrasilia(desde);
  const ultimo = inicioDoDiaBrasilia(ate);
  const out: Date[] = [];
  for (
    let t = primeiro.getTime();
    t <= ultimo.getTime();
    t += 86_400_000
  ) {
    out.push(new Date(t));
  }
  return out;
}

/**
 * Série contínua do gráfico "Vendas no período".
 *
 * Sempre devolve um ponto por balde da janela — inclusive zeros. Antes só
 * existia balde quando havia transação, então o eixo X colapsava num único
 * "19h" se a conta tivesse uma venda naquela hora.
 *
 * `porHora`: últimas 24h, N = 24/48/96 conforme `intervalo`.
 * Caso contrário: um ponto por dia civil em Brasília, do `desde` ao `ate`.
 */
export function montarSerieDashboard(input: {
  desde: Date;
  ate: Date;
  porHora: boolean;
  intervalo: IntervaloSerie24h;
  linhas: LinhaSerieDashboard[];
}): PontoSerieDashboard[] {
  const minutos = input.porHora ? INTERVALOS_SERIE_24H[input.intervalo] : 24 * 60;
  const baldes = input.porHora
    ? gerarBaldesPorMinuto(input.ate, minutos)
    : gerarBaldesDiarios(input.desde, input.ate);
  const n = baldes.length;
  if (n === 0) return [];

  const ms = input.porHora ? minutos * 60 * 1000 : 86_400_000;
  const primeiro = baldes[0].getTime();
  const geradas = Array.from({ length: n }, () => money(0));
  const aprovadas = Array.from({ length: n }, () => money(0));
  const pendentes = Array.from({ length: n }, () => money(0));

  for (const linha of input.linhas) {
    const t = linha.criadoEm.getTime();
    if (t < input.desde.getTime() || t > input.ate.getTime()) continue;
    const idx = Math.min(
      n - 1,
      Math.max(0, Math.floor((t - primeiro) / ms)),
    );
    const v = money(linha.valorBruto.toString());
    geradas[idx] = geradas[idx].plus(v);
    if (SITUACOES_APROVADAS_SERIE.includes(linha.situacao)) {
      aprovadas[idx] = aprovadas[idx].plus(v);
    } else if (linha.situacao === SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO) {
      pendentes[idx] = pendentes[idx].plus(v);
    }
  }

  return baldes.map((inicio, i) => ({
    ts: inicio.toISOString(),
    label: input.porHora ? rotuloPorHora(inicio, minutos) : rotuloDia(inicio),
    geradas: moneyToString(geradas[i]),
    aprovadas: moneyToString(aprovadas[i]),
    pendentes: moneyToString(pendentes[i]),
  }));
}
