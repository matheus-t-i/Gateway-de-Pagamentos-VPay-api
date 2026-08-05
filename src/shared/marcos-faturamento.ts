/**
 * Marcos de faturamento (GMV) — faixas de premiação do lojista.
 * Config estática: o progresso é calculado em tempo real a partir das
 * transações ENTRADA liquidadas/concluídas.
 */

export type CodigoMarcoFaturamento =
  | 'PRATA'
  | 'OURO'
  | 'PLATINA'
  | 'BLACK'
  | 'DIAMANTE';

export type MarcoFaturamentoDef = {
  codigo: CodigoMarcoFaturamento;
  nome: string;
  /** Meta de GMV acumulado em reais. */
  meta: number;
  faixa: 'inicial' | 'intermediario' | 'avancado';
  descricao: string;
};

export const MARCOS_FATURAMENTO: readonly MarcoFaturamentoDef[] = [
  {
    codigo: 'PRATA',
    nome: 'Prata',
    meta: 50_000,
    faixa: 'inicial',
    descricao: 'Primeiro marco — R$ 50 mil processados na plataforma.',
  },
  {
    codigo: 'OURO',
    nome: 'Ouro',
    meta: 100_000,
    faixa: 'intermediario',
    descricao: 'Escala intermediária — R$ 100 mil de volume bruto.',
  },
  {
    codigo: 'PLATINA',
    nome: 'Platina',
    meta: 500_000,
    faixa: 'intermediario',
    descricao: 'Operação consolidada — R$ 500 mil processados.',
  },
  {
    codigo: 'BLACK',
    nome: 'Black',
    meta: 1_000_000,
    faixa: 'avancado',
    descricao: 'Elite do ecossistema — R$ 1 milhão de GMV.',
  },
  {
    codigo: 'DIAMANTE',
    nome: 'Diamante',
    meta: 10_000_000,
    faixa: 'avancado',
    descricao: 'Topo da trilha — R$ 10 milhões processados.',
  },
] as const;

export type MarcoFaturamentoStatus = {
  codigo: CodigoMarcoFaturamento;
  nome: string;
  meta: string;
  faixa: MarcoFaturamentoDef['faixa'];
  descricao: string;
  desbloqueado: boolean;
  /** Progresso 0–1 em direção a este marco (1 = atingido). */
  progresso: number;
};

export type ProgressoFaturamento = {
  gmvAcumulado: string;
  qtdPagas: number;
  nivelAtual: {
    codigo: CodigoMarcoFaturamento;
    nome: string;
    meta: string;
  } | null;
  proximoMarco: {
    codigo: CodigoMarcoFaturamento;
    nome: string;
    meta: string;
    restante: string;
    progresso: number;
  } | null;
  marcos: MarcoFaturamentoStatus[];
};

function clamp01(n: number): number {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** Monta o payload de progresso a partir do GMV lifetime (número). */
export function calcularProgressoFaturamento(
  gmv: number,
  qtdPagas: number,
): ProgressoFaturamento {
  const marcos: MarcoFaturamentoStatus[] = MARCOS_FATURAMENTO.map((m) => ({
    codigo: m.codigo,
    nome: m.nome,
    meta: m.meta.toFixed(2),
    faixa: m.faixa,
    descricao: m.descricao,
    desbloqueado: gmv >= m.meta,
    progresso: clamp01(gmv / m.meta),
  }));

  const desbloqueados = MARCOS_FATURAMENTO.filter((m) => gmv >= m.meta);
  const nivelDef = desbloqueados[desbloqueados.length - 1] ?? null;
  const proximoDef = MARCOS_FATURAMENTO.find((m) => gmv < m.meta) ?? null;

  const baseAnterior =
    nivelDef?.meta ??
    0;
  const progressoProximo = proximoDef
    ? clamp01((gmv - baseAnterior) / (proximoDef.meta - baseAnterior))
    : 1;

  return {
    gmvAcumulado: gmv.toFixed(2),
    qtdPagas,
    nivelAtual: nivelDef
      ? {
          codigo: nivelDef.codigo,
          nome: nivelDef.nome,
          meta: nivelDef.meta.toFixed(2),
        }
      : null,
    proximoMarco: proximoDef
      ? {
          codigo: proximoDef.codigo,
          nome: proximoDef.nome,
          meta: proximoDef.meta.toFixed(2),
          restante: Math.max(0, proximoDef.meta - gmv).toFixed(2),
          progresso: progressoProximo,
        }
      : null,
    marcos,
  };
}
