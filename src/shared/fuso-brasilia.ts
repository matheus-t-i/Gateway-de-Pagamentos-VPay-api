/**
 * Fuso do produto: Brasília (`America/Sao_Paulo`).
 *
 * Persistência continua `timestamptz` / instante UTC. Este módulo é o recorte
 * de **dia civil** e a apresentação — nunca grave Date “local” no banco.
 *
 * Sem horário de verão desde 2019: BRT = UTC−3 o ano todo. O OFFSET vive SÓ
 * aqui; callers usam as funções, não o número.
 */
export const FUSO_BRASILIA = 'America/Sao_Paulo';

/** UTC−3 em ms. Uso interno + testes. Não copiar para outros arquivos. */
export const OFFSET_BRT_MS = 3 * 60 * 60 * 1000;

export type PartesBrasilia = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * Componentes do relógio de parede em Brasília a partir de um instante UTC.
 *
 * `getUTCHours()` no Date cru devolve hora UTC (16:08 BRT → 19h) — é o bug
 * do eixo do gráfico. Sempre passar por aqui para rótulo / agrupamento.
 */
export function partesBrasilia(d: Date): PartesBrasilia {
  const t = new Date(d.getTime() - OFFSET_BRT_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
  };
}

/** Instante UTC correspondente a um relógio de parede em Brasília. */
export function deBrasilia(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms) + OFFSET_BRT_MS,
  );
}

/** Meia-noite BRT do dia civil que contém `d` (= 03:00 UTC, sem DST). */
export function inicioDoDiaBrasilia(d = new Date()): Date {
  const p = partesBrasilia(d);
  return deBrasilia(p.year, p.month, p.day, 0, 0, 0, 0);
}

/** 23:59:59.999 BRT do dia civil que contém `d`. */
export function fimDoDiaBrasilia(d = new Date()): Date {
  const p = partesBrasilia(d);
  return deBrasilia(p.year, p.month, p.day, 23, 59, 59, 999);
}

/** Dia civil em Brasília, `YYYY-MM-DD`. Independente do fuso do processo. */
export function diaCivilBrasilia(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_BRASILIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** `YYYY-MM` do mês civil em Brasília. */
export function chaveMesBrasilia(d: Date): string {
  const p = partesBrasilia(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** Primeiro instante BRT do mês civil que contém `d`. */
export function inicioDoMesBrasilia(d = new Date()): Date {
  const p = partesBrasilia(d);
  return deBrasilia(p.year, p.month, 1, 0, 0);
}

/** Primeiro instante BRT de (mês atual − `mesesAtras`). */
export function inicioDoMesBrasiliaOffset(
  mesesAtras: number,
  d = new Date(),
): Date {
  const p = partesBrasilia(d);
  const idx = p.year * 12 + (p.month - 1) - mesesAtras;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return deBrasilia(year, month, 1, 0, 0);
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  const m = YMD.exec(ymd.trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 00:00:00.000 BRT do `YYYY-MM-DD` (filtro `dataInicial`). */
export function inicioDoDiaCivil(ymd: string): Date | undefined {
  const p = parseYmd(ymd);
  return p ? deBrasilia(p.year, p.month, p.day, 0, 0, 0, 0) : undefined;
}

/** 23:59:59.999 BRT do `YYYY-MM-DD` (filtro `dataFinal`). */
export function fimDoDiaCivil(ymd: string): Date | undefined {
  const p = parseYmd(ymd);
  return p ? deBrasilia(p.year, p.month, p.day, 23, 59, 59, 999) : undefined;
}

/**
 * Recorte `[gte, lte]` de um filtro de data do painel. `YYYY-MM-DD` é dia
 * civil em Brasília — `new Date(ymd + 'T00:00:00')` no Render (UTC) corta
 * o expediente 3h cedo.
 */
export function recorteFiltroData(
  dataInicial?: string,
  dataFinal?: string,
): { gte?: Date; lte?: Date } | undefined {
  const gte = dataInicial ? inicioDoDiaCivil(dataInicial) : undefined;
  const lte = dataFinal ? fimDoDiaCivil(dataFinal) : undefined;
  if (!gte && !lte) return undefined;
  return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
}

/** Início/fim do dia civil SP como Date para filtrar timestamptz. */
export function intervaloDiaCivilBrasilia(diaYmd: string): {
  inicio: Date;
  fim: Date;
} {
  return {
    inicio: inicioDoDiaCivil(diaYmd) ?? new Date(NaN),
    fim: fimDoDiaCivil(diaYmd) ?? new Date(NaN),
  };
}

/**
 * `2026-08-03 11:40:04` no fuso de Brasília — callback ao lojista (`dataHoraBr`).
 * `sv-SE` só porque produz exatamente `YYYY-MM-DD HH:mm:ss`.
 */
export function dataHoraBr(data: Date): string {
  return data.toLocaleString('sv-SE', { timeZone: FUSO_BRASILIA });
}

/**
 * Alias do dia civil — o nome antigo viveu em retenção/MED. Preferir
 * `diaCivilBrasilia` em código novo.
 */
export const diaCivilSaoPaulo = diaCivilBrasilia;
