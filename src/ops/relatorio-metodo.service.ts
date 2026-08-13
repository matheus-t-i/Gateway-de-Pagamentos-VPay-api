import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  diaCivilBrasilia,
  FUSO_BRASILIA,
  money,
  moneyToString,
  SITUACAO_TRANSACAO,
} from '../shared';

/** Limite da tabela "Por usuário" (ordenado por pagas DESC). */
const LIMITE_POR_USUARIO = 300;

type FiltrosMetodo = {
  dataInicial: string;
  dataFinal: string;
  /** Código do provedor; vazio = todas. */
  adquirente?: string;
  /** Busca em nome/e-mail/idPublico do lojista (só afeta tabela Por usuário). */
  usuario?: string;
  ocultarRetidas?: boolean;
};

type TotaisBrutos = {
  aguardandoValor: string;
  aguardandoQtd: bigint;
  pagasValor: string;
  pagasQtd: bigint;
  retidasValor: string;
  retidasQtd: bigint;
  medEmRetidasValor: string;
  medEmRetidasQtd: bigint;
  medValor: string;
  medQtd: bigint;
  medsRetidosValor: string;
  medsRetidosQtd: bigint;
};

type LinhaAdquirente = TotaisBrutos & {
  codigo: string;
  nome: string;
};

type LinhaUsuario = TotaisBrutos & {
  idPublico: string;
  nome: string;
  email: string;
};

function hojeSp(): string {
  return diaCivilBrasilia();
}

function diasPeriodo(inicio: string, fim: string): number {
  const a = Date.parse(inicio + 'T00:00:00Z');
  const b = Date.parse(fim + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.floor((b - a) / 86_400_000) + 1;
}

function pct(parte: ReturnType<typeof money>, base: ReturnType<typeof money>): string {
  if (base.isZero()) return '0.00';
  return moneyToString(parte.mul(100).div(base));
}

function montarMetricas(t: TotaisBrutos, ocultarRetidas: boolean) {
  const aguardando = money(t.aguardandoValor);
  const pagas = money(t.pagasValor);
  const retidas = money(t.retidasValor);
  const medEmRetidas = money(t.medEmRetidasValor);
  const med = money(t.medValor);
  const medsRetidos = money(t.medsRetidosValor);

  const retidasNaBase = ocultarRetidas ? money(0) : retidas;
  const base = aguardando.plus(pagas).plus(retidasNaBase).plus(med);
  const totalRecebido = pagas.plus(retidas).plus(med);

  const denomConversao = pagas.plus(aguardando);
  const taxaConversao = pct(pagas, denomConversao);
  const pctRetidas = pct(retidas, pagas);
  // Legado: taxa real = conversão + % retidas (aditivo).
  const taxaConversaoReal = moneyToString(
    money(taxaConversao).plus(money(pctRetidas)),
  );

  const qtdAguardando = Number(t.aguardandoQtd);
  const qtdPagas = Number(t.pagasQtd);
  const denomTx = qtdAguardando + qtdPagas;
  const conversaoTransacao =
    denomTx > 0 ? moneyToString(money(qtdPagas).mul(100).div(denomTx)) : '0.00';

  const denomMed = pagas.plus(retidasNaBase).plus(med);
  const pctMed = pct(med, denomMed);

  return {
    aguardando: {
      valor: moneyToString(aguardando),
      qtd: qtdAguardando,
      pct: pct(aguardando, base),
    },
    pagas: {
      valor: moneyToString(pagas),
      qtd: qtdPagas,
      pct: pct(pagas, base),
    },
    retidas: {
      valor: moneyToString(retidas),
      qtd: Number(t.retidasQtd),
      pct: pct(retidas, base),
    },
    medEmRetidas: {
      valor: moneyToString(medEmRetidas),
      qtd: Number(t.medEmRetidasQtd),
      pct: pct(medEmRetidas, base),
    },
    med: {
      valor: moneyToString(med),
      qtd: Number(t.medQtd),
      pct: pct(med, base),
    },
    medsRetidos: {
      valor: moneyToString(medsRetidos),
      qtd: Number(t.medsRetidosQtd),
      pct: pct(medsRetidos, base),
    },
    totalRecebido: {
      valor: moneyToString(totalRecebido),
      pct: pct(totalRecebido, base),
    },
    taxaConversao,
    taxaConversaoReal,
    conversaoTransacao,
    pctRetidas,
    pctMed,
  };
}

const ZERO: TotaisBrutos = {
  aguardandoValor: '0',
  aguardandoQtd: 0n,
  pagasValor: '0',
  pagasQtd: 0n,
  retidasValor: '0',
  retidasQtd: 0n,
  medEmRetidasValor: '0',
  medEmRetidasQtd: 0n,
  medValor: '0',
  medQtd: 0n,
  medsRetidosValor: '0',
  medsRetidosQtd: 0n,
};

/**
 * Relatório Método — dashboard operacional de cash-in PIX.
 *
 * Mapeamento legado → VPay:
 * - Aguardando → AGUARDANDO_PAGAMENTO e retida_metodo = false (data: criado_em)
 * - Pagas → CONCLUIDA (data: liquidado_em / concluido_em)
 * - Retidas → retida_metodo = true ainda em AGUARDANDO_PAGAMENTO (paga na liquidante, sem crédito)
 * - MED → situacao MED (data: primeiro_med_recebido_em)
 * - MED em retidas → MED + retida_metodo
 * - MEDs retidos (contenção) → med_automatico = true (não há coluna legado de contenção)
 */
@Injectable()
export class RelatorioMetodoService {
  constructor(private readonly prisma: PrismaService) {}

  async gerar(q: FiltrosMetodo) {
    const dataInicial = q.dataInicial || hojeSp();
    const dataFinal = q.dataFinal || hojeSp();
    const adquirente = (q.adquirente ?? '').trim();
    const usuario = (q.usuario ?? '').trim();
    const ocultarRetidas = !!q.ocultarRetidas;
    const dias = diasPeriodo(dataInicial, dataFinal);

    const [
      geralRows,
      filtradoRows,
      porAdq,
      porUsuario,
      porUsuarioFiltrado,
      saude,
      tempoAdq,
    ] = await Promise.all([
      this.agregarTotais({ dataInicial, dataFinal, adquirente: undefined }),
      adquirente
        ? this.agregarTotais({ dataInicial, dataFinal, adquirente })
        : Promise.resolve(null),
      this.agregarPorAdquirente({ dataInicial, dataFinal }),
      this.agregarPorUsuario({
        dataInicial,
        dataFinal,
        adquirente: undefined,
        usuario,
      }),
      adquirente
        ? this.agregarPorUsuario({
            dataInicial,
            dataFinal,
            adquirente,
            usuario,
          })
        : Promise.resolve(null),
      this.saudePix(),
      this.tempoPorAdquirente(),
    ]);

    const geral = montarMetricas(geralRows ?? ZERO, ocultarRetidas);
    const filtrado = filtradoRows
      ? montarMetricas(filtradoRows, ocultarRetidas)
      : null;

    const tempoMap = new Map(
      tempoAdq.map((r) => [
        r.codigo,
        {
          minutosPagas:
            r.minutosDesdeUltimaPaga != null
              ? Math.max(0, Math.floor(Number(r.minutosDesdeUltimaPaga)))
              : null,
          minutosAguardando:
            r.minutosDesdeUltimaAguardando != null
              ? Math.max(0, Math.floor(Number(r.minutosDesdeUltimaAguardando)))
              : null,
        },
      ] as const),
    );

    const porAdquirente = porAdq.map((r) => {
      const m = montarMetricas(r, ocultarRetidas);
      const t = tempoMap.get(r.codigo);
      return {
        codigo: r.codigo,
        nome: r.nome,
        ...m,
        statusTempo: {
          minutosPagas: t?.minutosPagas ?? null,
          minutosAguardando: t?.minutosAguardando ?? null,
          tevePagaNoPeriodo: Number(r.pagasQtd) > 0,
          teveAguardandoNoPeriodo: Number(r.aguardandoQtd) > 0,
        },
      };
    });

    const mapUsuario = (lista: LinhaUsuario[]) =>
      lista.map((r) => ({
        idPublico: r.idPublico,
        nome: r.nome,
        email: r.email,
        ...montarMetricas(r, ocultarRetidas),
      }));

    // Gráfico só quando adquirente = todas (evita série enviesada pelo filtro).
    const grafico = adquirente
      ? null
      : await this.grafico({ dataInicial, dataFinal, dias });

    return {
      filtros: {
        dataInicial,
        dataFinal,
        adquirente: adquirente || null,
        usuario: usuario || null,
        ocultarRetidas,
      },
      diasPeriodo: dias,
      saude,
      geral,
      filtrado,
      porAdquirente,
      porUsuario: mapUsuario(porUsuario),
      porUsuarioFiltrado: porUsuarioFiltrado
        ? mapUsuario(porUsuarioFiltrado)
        : null,
      grafico,
      notas: {
        retidas:
          'Vendas com retida_metodo=true ainda em AGUARDANDO_PAGAMENTO (pagas na liquidante, sem crédito ao lojista).',
        medsRetidos:
          'Equivalente mais próximo do legado "MEDs retidos/contenção": transações com med_automatico=true.',
        medEmRetidas: 'Situação MED com histórico de retenção pelo método (retida_metodo).',
      },
    };
  }

  /** Saúde PIX — sync leve (últimos minutos, sem filtro de período). */
  private async saudePix() {
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;

    const rows = await this.prisma.$queryRaw<
      Array<{
        pagas_2: bigint;
        pagas_4: bigint;
        ag_2: bigint;
        ag_4: bigint;
        min_desde_paga: number | null;
        min_desde_ag: number | null;
      }>
    >`
      SELECT
        (
          SELECT COUNT(*)::bigint FROM transacoes
          WHERE situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND COALESCE(liquidado_em, concluido_em) >= NOW() - INTERVAL '2 minutes'
        ) AS pagas_2,
        (
          SELECT COUNT(*)::bigint FROM transacoes
          WHERE situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND COALESCE(liquidado_em, concluido_em) >= NOW() - INTERVAL '4 minutes'
        ) AS pagas_4,
        (
          SELECT COUNT(*)::bigint FROM transacoes
          WHERE situacao = ${AG}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND retida_metodo = false
            AND criado_em >= NOW() - INTERVAL '2 minutes'
        ) AS ag_2,
        (
          SELECT COUNT(*)::bigint FROM transacoes
          WHERE situacao = ${AG}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND retida_metodo = false
            AND criado_em >= NOW() - INTERVAL '4 minutes'
        ) AS ag_4,
        (
          SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(liquidado_em, concluido_em))) / 60
          FROM transacoes
          WHERE situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND COALESCE(liquidado_em, concluido_em) IS NOT NULL
          ORDER BY COALESCE(liquidado_em, concluido_em) DESC
          LIMIT 1
        )::float AS min_desde_paga,
        (
          SELECT EXTRACT(EPOCH FROM (NOW() - criado_em)) / 60
          FROM transacoes
          WHERE situacao = ${AG}::"SituacaoTransacao"
            AND direcao = 'ENTRADA'
            AND retida_metodo = false
          ORDER BY criado_em DESC
          LIMIT 1
        )::float AS min_desde_ag
    `;

    const r = rows[0];
    const pagas2 = Number(r?.pagas_2 ?? 0);
    const pagas4 = Number(r?.pagas_4 ?? 0);
    const ag2 = Number(r?.ag_2 ?? 0);
    const ag4 = Number(r?.ag_4 ?? 0);
    const minPaga =
      r?.min_desde_paga != null ? Math.max(0, Math.floor(r.min_desde_paga)) : null;
    const minAg =
      r?.min_desde_ag != null ? Math.max(0, Math.floor(r.min_desde_ag)) : null;

    const nivel = (em2: number, em4: number, minutos: number | null) => {
      if (em2 > 0) return 'ok' as const;
      if (em4 > 0) return 'alerta' as const;
      if (minutos == null) return 'critico' as const;
      if (minutos <= 2) return 'ok' as const;
      if (minutos <= 4) return 'alerta' as const;
      return 'critico' as const;
    };

    const msgPagas =
      pagas2 > 0
        ? 'Pagas: Teve venda paga nos últimos 2 minutos. Está tudo certo com o sistema.'
        : pagas4 > 0
          ? 'Pagas: Teve venda paga nos últimos 4 minutos. Atenção — volume baixo.'
          : minPaga == null
            ? 'Pagas: Nenhuma venda paga registrada ainda.'
            : `Pagas: Sem venda paga há ${minPaga} min. Verifique a liquidante.`;

    const msgAguardando =
      ag2 > 0
        ? 'Aguardando: Teve venda aguardando pagamento nos últimos 2 minutos. Está tudo certo.'
        : ag4 > 0
          ? 'Aguardando: Teve venda gerada nos últimos 4 minutos. Atenção — volume baixo.'
          : minAg == null
            ? 'Aguardando: Nenhuma cobrança gerada ainda.'
            : `Aguardando: Sem cobrança gerada há ${minAg} min. Verifique a API de criação.`;

    return {
      pagas: {
        ultimos2min: pagas2,
        ultimos4min: pagas4,
        minutosDesdeUltima: pagas4 === 0 ? minPaga : null,
        nivel: nivel(pagas2, pagas4, minPaga),
      },
      aguardando: {
        ultimos2min: ag2,
        ultimos4min: ag4,
        minutosDesdeUltima: ag4 === 0 ? minAg : null,
        nivel: nivel(ag2, ag4, minAg),
      },
      mensagemPagas: msgPagas,
      mensagemAguardando: msgAguardando,
    };
  }

  private async tempoPorAdquirente() {
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;

    return this.prisma.$queryRaw<
      Array<{
        codigo: string;
        minutosDesdeUltimaPaga: number | null;
        minutosDesdeUltimaAguardando: number | null;
      }>
    >`
      SELECT
        pp.codigo,
        (
          SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(t.liquidado_em, t.concluido_em))) / 60
          FROM transacoes t
          JOIN contas_provedor cp2 ON cp2.id = t.conta_provedor_id
          WHERE cp2.provedor_pagamento_id = pp.id
            AND t.direcao = 'ENTRADA'
            AND t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND COALESCE(t.liquidado_em, t.concluido_em) IS NOT NULL
          ORDER BY COALESCE(t.liquidado_em, t.concluido_em) DESC
          LIMIT 1
        )::float AS "minutosDesdeUltimaPaga",
        (
          SELECT EXTRACT(EPOCH FROM (NOW() - t.criado_em)) / 60
          FROM transacoes t
          JOIN contas_provedor cp2 ON cp2.id = t.conta_provedor_id
          WHERE cp2.provedor_pagamento_id = pp.id
            AND t.direcao = 'ENTRADA'
            AND t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = false
          ORDER BY t.criado_em DESC
          LIMIT 1
        )::float AS "minutosDesdeUltimaAguardando"
      FROM provedores_pagamento pp
      WHERE EXISTS (
        SELECT 1 FROM contas_provedor cp WHERE cp.provedor_pagamento_id = pp.id
      )
    `;
  }

  private async agregarTotais(input: {
    dataInicial: string;
    dataFinal: string;
    adquirente?: string;
  }): Promise<TotaisBrutos> {
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;
    const MED = SITUACAO_TRANSACAO.MED;
    const filtroAdq = input.adquirente
      ? Prisma.sql`AND pp.codigo = ${input.adquirente}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<TotaisBrutos[]>`
      WITH bounds AS (
        SELECT
          (${input.dataInicial}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ini,
          ((${input.dataFinal}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS fim
      )
      SELECT
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = false
            AND t.criado_em >= b.ini AND t.criado_em < b.fim
        ), 0)::text AS "aguardandoValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = false
            AND t.criado_em >= b.ini AND t.criado_em < b.fim
        )::bigint AS "aguardandoQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
        ), 0)::text AS "pagasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
        )::bigint AS "pagasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
        ), 0)::text AS "retidasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
        )::bigint AS "retidasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medEmRetidasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medEmRetidasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.med_automatico = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medsRetidosValor",
        COUNT(*) FILTER (
          WHERE t.med_automatico = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medsRetidosQtd"
      FROM transacoes t
      CROSS JOIN bounds b
      LEFT JOIN contas_provedor cp ON cp.id = t.conta_provedor_id
      LEFT JOIN provedores_pagamento pp ON pp.id = cp.provedor_pagamento_id
      WHERE t.direcao = 'ENTRADA'
        ${filtroAdq}
    `;

    return rows[0] ?? ZERO;
  }

  private async agregarPorAdquirente(input: {
    dataInicial: string;
    dataFinal: string;
  }): Promise<LinhaAdquirente[]> {
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;
    const MED = SITUACAO_TRANSACAO.MED;

    return this.prisma.$queryRaw<LinhaAdquirente[]>`
      WITH bounds AS (
        SELECT
          (${input.dataInicial}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ini,
          ((${input.dataFinal}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS fim
      )
      SELECT
        pp.codigo,
        COALESCE(pp.nome_fantasia, pp.nome) AS nome,
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = false
            AND t.criado_em >= b.ini AND t.criado_em < b.fim
        ), 0)::text AS "aguardandoValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = false
            AND t.criado_em >= b.ini AND t.criado_em < b.fim
        )::bigint AS "aguardandoQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
        ), 0)::text AS "pagasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
        )::bigint AS "pagasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
        ), 0)::text AS "retidasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${AG}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
            AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
        )::bigint AS "retidasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medEmRetidasValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND t.retida_metodo = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medEmRetidasQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medValor",
        COUNT(*) FILTER (
          WHERE t.situacao = ${MED}::"SituacaoTransacao"
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medQtd",
        COALESCE(SUM(t.valor_bruto) FILTER (
          WHERE t.med_automatico = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        ), 0)::text AS "medsRetidosValor",
        COUNT(*) FILTER (
          WHERE t.med_automatico = true
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
            AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
        )::bigint AS "medsRetidosQtd"
      FROM provedores_pagamento pp
      CROSS JOIN bounds b
      LEFT JOIN contas_provedor cp ON cp.provedor_pagamento_id = pp.id
      LEFT JOIN transacoes t ON t.conta_provedor_id = cp.id AND t.direcao = 'ENTRADA'
      GROUP BY pp.id, pp.codigo, pp.nome, pp.nome_fantasia, b.ini, b.fim
      HAVING
        COUNT(*) FILTER (
          WHERE t.id IS NOT NULL AND (
            (t.situacao = ${AG}::"SituacaoTransacao" AND t.criado_em >= b.ini AND t.criado_em < b.fim)
            OR (t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
                AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
                AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim)
            OR (t.situacao = ${MED}::"SituacaoTransacao"
                AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
                AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim)
            OR (t.retida_metodo = true
                AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
                AND COALESCE(t.liquidado_em, t.criado_em) < b.fim)
          )
        ) > 0
      ORDER BY COALESCE(SUM(t.valor_bruto) FILTER (
        WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
          AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
          AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
      ), 0) DESC
    `;
  }

  private async agregarPorUsuario(input: {
    dataInicial: string;
    dataFinal: string;
    adquirente?: string;
    usuario?: string;
  }): Promise<LinhaUsuario[]> {
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;
    const MED = SITUACAO_TRANSACAO.MED;
    const filtroAdq = input.adquirente
      ? Prisma.sql`AND pp.codigo = ${input.adquirente}`
      : Prisma.empty;
    const busca = (input.usuario ?? '').trim();
    const filtroUser = busca
      ? Prisma.sql`AND (
          u.nome_razao_social ILIKE ${'%' + busca + '%'}
          OR u.email ILIKE ${'%' + busca + '%'}
          OR u.id_publico::text ILIKE ${'%' + busca + '%'}
          OR u.nome_fantasia ILIKE ${'%' + busca + '%'}
        )`
      : Prisma.empty;

    return this.prisma.$queryRaw<LinhaUsuario[]>`
      WITH bounds AS (
        SELECT
          (${input.dataInicial}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ini,
          ((${input.dataFinal}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS fim
      ),
      base AS (
        SELECT
          u.id,
          u.id_publico AS "idPublico",
          COALESCE(u.nome_fantasia, u.nome_razao_social) AS nome,
          u.email,
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.situacao = ${AG}::"SituacaoTransacao"
              AND t.retida_metodo = false
              AND t.criado_em >= b.ini AND t.criado_em < b.fim
          ), 0)::text AS "aguardandoValor",
          COUNT(*) FILTER (
            WHERE t.situacao = ${AG}::"SituacaoTransacao"
              AND t.retida_metodo = false
              AND t.criado_em >= b.ini AND t.criado_em < b.fim
          )::bigint AS "aguardandoQtd",
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
              AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
              AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
          ), 0)::text AS "pagasValor",
          COUNT(*) FILTER (
            WHERE t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
              AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
              AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
          )::bigint AS "pagasQtd",
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.situacao = ${AG}::"SituacaoTransacao"
              AND t.retida_metodo = true
              AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
              AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
          ), 0)::text AS "retidasValor",
          COUNT(*) FILTER (
            WHERE t.situacao = ${AG}::"SituacaoTransacao"
              AND t.retida_metodo = true
              AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
              AND COALESCE(t.liquidado_em, t.criado_em) < b.fim
          )::bigint AS "retidasQtd",
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.situacao = ${MED}::"SituacaoTransacao"
              AND t.retida_metodo = true
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          ), 0)::text AS "medEmRetidasValor",
          COUNT(*) FILTER (
            WHERE t.situacao = ${MED}::"SituacaoTransacao"
              AND t.retida_metodo = true
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          )::bigint AS "medEmRetidasQtd",
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.situacao = ${MED}::"SituacaoTransacao"
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          ), 0)::text AS "medValor",
          COUNT(*) FILTER (
            WHERE t.situacao = ${MED}::"SituacaoTransacao"
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          )::bigint AS "medQtd",
          COALESCE(SUM(t.valor_bruto) FILTER (
            WHERE t.med_automatico = true
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          ), 0)::text AS "medsRetidosValor",
          COUNT(*) FILTER (
            WHERE t.med_automatico = true
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
              AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
          )::bigint AS "medsRetidosQtd"
        FROM usuarios u
        CROSS JOIN bounds b
        INNER JOIN transacoes t ON t.usuario_id = u.id AND t.direcao = 'ENTRADA'
        LEFT JOIN contas_provedor cp ON cp.id = t.conta_provedor_id
        LEFT JOIN provedores_pagamento pp ON pp.id = cp.provedor_pagamento_id
        WHERE 1=1
          ${filtroAdq}
          ${filtroUser}
          AND (
            (t.situacao = ${AG}::"SituacaoTransacao" AND t.criado_em >= b.ini AND t.criado_em < b.fim)
            OR (t.situacao = ${CONCLUIDA}::"SituacaoTransacao"
                AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
                AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim)
            OR (t.situacao = ${MED}::"SituacaoTransacao"
                AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
                AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim)
            OR (t.retida_metodo = true AND t.situacao = ${AG}::"SituacaoTransacao"
                AND COALESCE(t.liquidado_em, t.criado_em) >= b.ini
                AND COALESCE(t.liquidado_em, t.criado_em) < b.fim)
          )
        GROUP BY u.id, u.id_publico, u.nome_fantasia, u.nome_razao_social, u.email
      )
      SELECT *
      FROM base
      ORDER BY "pagasValor"::numeric DESC
      LIMIT ${LIMITE_POR_USUARIO}
    `;
  }

  private async grafico(input: {
    dataInicial: string;
    dataFinal: string;
    dias: number;
  }) {
    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;
    const MED = SITUACAO_TRANSACAO.MED;
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;

    let trunc: string;
    let rotuloGranularidade: string;
    if (input.dias < 2) {
      trunc = '30 minutes';
      rotuloGranularidade = 'A cada 30 minutos';
    } else if (input.dias <= 31) {
      trunc = 'day';
      rotuloGranularidade = 'Por dia';
    } else {
      trunc = 'month';
      rotuloGranularidade = 'Por mês';
    }

    // date_trunc com intervalo dinâmico via literal seguro (só 3 valores fixos).
    // date_trunc em timestamp naive (BRT) + AT TIME ZONE de volta = timestamptz
    // da meia-noite/hora BRT. Sem o round-trip o node-pg lê naive como UTC e o
    // rótulo com America/Sao_Paulo atraso 3h (13/08 vira 12/08).
    const bucketExpr =
      trunc === '30 minutes'
        ? Prisma.sql`(date_trunc('hour', ts AT TIME ZONE 'America/Sao_Paulo')
            + INTERVAL '30 minutes' * FLOOR(EXTRACT(MINUTE FROM (ts AT TIME ZONE 'America/Sao_Paulo')) / 30)
          ) AT TIME ZONE 'America/Sao_Paulo'`
        : trunc === 'day'
          ? Prisma.sql`(date_trunc('day', ts AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`
          : Prisma.sql`(date_trunc('month', ts AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')`;

    const rows = await this.prisma.$queryRaw<
      Array<{ bucket: Date; faturamento: string; med: string }>
    >`
      WITH bounds AS (
        SELECT
          (${input.dataInicial}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AS ini,
          ((${input.dataFinal}::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AS fim
      ),
      eventos AS (
        SELECT
          COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) AS ts,
          t.valor_bruto AS fat,
          0::numeric AS med_v
        FROM transacoes t, bounds b
        WHERE t.direcao = 'ENTRADA'
          AND (
            (t.situacao = ${CONCLUIDA}::"SituacaoTransacao")
            OR (t.situacao = ${AG}::"SituacaoTransacao" AND t.retida_metodo = true)
          )
          AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) >= b.ini
          AND COALESCE(t.liquidado_em, t.concluido_em, t.criado_em) < b.fim
        UNION ALL
        SELECT
          COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) AS ts,
          0::numeric AS fat,
          t.valor_bruto AS med_v
        FROM transacoes t, bounds b
        WHERE t.direcao = 'ENTRADA'
          AND (
            t.situacao = ${MED}::"SituacaoTransacao"
            OR t.med_automatico = true
          )
          AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) >= b.ini
          AND COALESCE(t.primeiro_med_recebido_em, t.atualizado_em) < b.fim
      )
      SELECT
        ${bucketExpr} AS bucket,
        COALESCE(SUM(fat), 0)::text AS faturamento,
        COALESCE(SUM(med_v), 0)::text AS med
      FROM eventos
      WHERE ts IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `;

    return {
      granularidade: rotuloGranularidade,
      pontos: rows.map((r) => ({
        em: r.bucket.toISOString(),
        label: formatarLabelBucket(r.bucket, trunc),
        faturamento: moneyToString(money(r.faturamento)),
        med: moneyToString(money(r.med)),
      })),
    };
  }
}

function formatarLabelBucket(d: Date, trunc: string): string {
  if (trunc === '30 minutes') {
    return d.toLocaleString('pt-BR', {
      timeZone: FUSO_BRASILIA,
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (trunc === 'day') {
    return d.toLocaleString('pt-BR', {
      timeZone: FUSO_BRASILIA,
      day: '2-digit',
      month: '2-digit',
    });
  }
  return d.toLocaleString('pt-BR', {
    timeZone: FUSO_BRASILIA,
    month: 'short',
    year: 'numeric',
  });
}
