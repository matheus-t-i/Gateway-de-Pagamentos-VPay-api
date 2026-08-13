import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  diaCivilBrasilia,
  Decimal,
  EVENTOS_LOJISTA,
  intervaloDiaCivilBrasilia,
  money,
  SITUACAO_CASO_MED,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { QueuesService } from '../queues/queues.service';

function sortearOffset(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function diaAnteriorSp(hojeYmd: string): string {
  const inicioHoje = intervaloDiaCivilBrasilia(hojeYmd).inicio;
  return diaCivilBrasilia(new Date(inicioHoje.getTime() - 1));
}

type EstadoRow = {
  usuario_id: bigint;
  offset_atual: number;
  data_referencia_dia: Date;
  valor_med_aplicado_dia: string;
};

type Decisao =
  | { acao: 'noop'; motivo: string }
  | {
      acao: 'aplicar';
      motivo: string;
      candidataId: bigint;
      valorCandidata: Decimal;
      valorMedDiaAntes: Decimal;
      hoje: string;
      offsetMin: number;
      offsetMax: number;
    };

@Injectable()
export class MedAutomaticoService {
  private readonly logger = new Logger(MedAutomaticoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly configPix: ConfigPixService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Avalia MED automático após crédito da venda atual.
   * A venda de hoje não muda; pode converter uma CONCLUIDA de ontem em MED.
   */
  async avaliar(input: {
    usuarioId: bigint;
    transacaoAtualId: bigint;
    valorBrutoAtual: Decimal;
  }): Promise<{ aplicado: boolean; motivo: string }> {
    const params =
      (await this.prisma.parametroMedAutomatico.findUnique({ where: { id: 1 } })) ??
      (await this.prisma.parametroMedAutomatico.create({ data: { id: 1 } }));

    if (!params.ativo) {
      return { aplicado: false, motivo: 'master_inativo' };
    }

    const cfg = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId: input.usuarioId },
    });
    if (!cfg?.medAutomaticoAtivo) {
      return { aplicado: false, motivo: 'cliente_inativo' };
    }
    const percCliente = money(cfg.percentualMedAutomatico.toString());
    if (percCliente.lte(0)) {
      return { aplicado: false, motivo: 'percentual_zero' };
    }

    const hoje = diaCivilBrasilia();
    const ontem = diaAnteriorSp(hoje);

    const decisao = await this.prisma.$transaction(async (tx) => {
      await tx.estadoMedAutomaticoUsuario.upsert({
        where: { usuarioId: input.usuarioId },
        create: {
          usuarioId: input.usuarioId,
          offsetAtual: 0,
          dataReferenciaDia: new Date('1970-01-01'),
          valorMedAplicadoDia: 0,
        },
        update: {},
      });

      const rows = await tx.$queryRaw<EstadoRow[]>`
        SELECT
          usuario_id,
          offset_atual,
          data_referencia_dia,
          valor_med_aplicado_dia::text
        FROM estados_med_automatico_usuario
        WHERE usuario_id = ${input.usuarioId}
        FOR UPDATE
      `;
      const estado = rows[0];
      if (!estado) {
        return { acao: 'noop', motivo: 'sem_estado' } satisfies Decisao;
      }

      let offsetAtual = estado.offset_atual;
      let valorMedDia = money(estado.valor_med_aplicado_dia);
      const dataRef = estado.data_referencia_dia.toISOString().slice(0, 10);
      if (dataRef !== hoje) {
        valorMedDia = money(0);
      }

      if (offsetAtual > 0) {
        await this.persistirEstado(tx, {
          usuarioId: input.usuarioId,
          hoje,
          offsetAtual: offsetAtual - 1,
          valorMedDia,
        });
        return { acao: 'noop', motivo: 'offset' } satisfies Decisao;
      }

      const { inicio: iniOntem, fim: fimOntem } = intervaloDiaCivilBrasilia(ontem);
      const agg = await tx.transacao.aggregate({
        where: {
          usuarioId: input.usuarioId,
          direcao: 'ENTRADA',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          OR: [
            { liquidadoEm: { gte: iniOntem, lte: fimOntem } },
            {
              AND: [
                { liquidadoEm: null },
                { concluidoEm: { gte: iniOntem, lte: fimOntem } },
              ],
            },
          ],
        },
        _sum: { valorBruto: true },
      });
      const fatOntem = money(agg._sum.valorBruto?.toString() ?? '0');
      if (fatOntem.lte(0)) {
        return { acao: 'noop', motivo: 'sem_faturamento_ontem' } satisfies Decisao;
      }

      const alvo = fatOntem.mul(percCliente).div(100);
      const falta = alvo.minus(valorMedDia);

      if (params.contencaoAtiva) {
        const teto = fatOntem
          .mul(money(params.percentualContencaoDia.toString()))
          .div(100);
        if (teto.gt(0) && valorMedDia.gte(teto)) {
          return { acao: 'noop', motivo: 'contencao' } satisfies Decisao;
        }
      }

      if (falta.lte(0)) {
        return { acao: 'noop', motivo: 'alvo_atingido' } satisfies Decisao;
      }

      const tolerancia = money(params.toleranciaValor.toString());
      const vAtual = input.valorBrutoAtual;
      if (vAtual.lt(falta.minus(tolerancia)) || vAtual.gt(falta.plus(tolerancia))) {
        return { acao: 'noop', motivo: 'fora_faixa' } satisfies Decisao;
      }

      const candidatas = await tx.transacao.findMany({
        where: {
          usuarioId: input.usuarioId,
          direcao: 'ENTRADA',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          medAutomatico: false,
          id: { not: input.transacaoAtualId },
          OR: [
            { liquidadoEm: { gte: iniOntem, lte: fimOntem } },
            {
              AND: [
                { liquidadoEm: null },
                { concluidoEm: { gte: iniOntem, lte: fimOntem } },
              ],
            },
          ],
          casosMed: { none: {} },
        },
        orderBy: { valorBruto: 'asc' },
        take: 50,
      });

      if (!candidatas.length) {
        return { acao: 'noop', motivo: 'sem_candidata' } satisfies Decisao;
      }

      let melhor = candidatas[0];
      let melhorDiff = money(melhor.valorBruto.toString()).minus(falta).abs();
      for (const c of candidatas) {
        const diff = money(c.valorBruto.toString()).minus(falta).abs();
        if (diff.lt(melhorDiff)) {
          melhor = c;
          melhorDiff = diff;
        }
      }

      // Trava a candidata até o fim desta tx de decisão (evita duas vendas pegarem a mesma).
      await tx.$executeRaw`
        SELECT id FROM transacoes WHERE id = ${melhor.id} FOR UPDATE
      `;
      const ainda = await tx.transacao.findUnique({ where: { id: melhor.id } });
      if (
        !ainda ||
        ainda.situacao !== SITUACAO_TRANSACAO.CONCLUIDA ||
        ainda.medAutomatico
      ) {
        return { acao: 'noop', motivo: 'candidata_indisponivel' } satisfies Decisao;
      }

      return {
        acao: 'aplicar',
        motivo: 'aplicado',
        candidataId: melhor.id,
        valorCandidata: money(melhor.valorBruto.toString()),
        valorMedDiaAntes: valorMedDia,
        hoje,
        offsetMin: params.offsetMin,
        offsetMax: params.offsetMax,
      } satisfies Decisao;
    });

    if (decisao.acao !== 'aplicar') {
      return { aplicado: false, motivo: decisao.motivo };
    }

    const aplicado = await this.aplicarMedNaCandidata({
      usuarioId: input.usuarioId,
      candidataId: decisao.candidataId,
      valor: decisao.valorCandidata,
      dia: decisao.hoje,
    });
    if (!aplicado) {
      return { aplicado: false, motivo: 'aplicacao_idempotente_ou_indisponivel' };
    }

    const novoOffset = sortearOffset(decisao.offsetMin, decisao.offsetMax);
    await this.prisma.$executeRaw`
      UPDATE estados_med_automatico_usuario
      SET
        offset_atual = ${novoOffset},
        data_referencia_dia = ${decisao.hoje}::date,
        valor_med_aplicado_dia = ${decisao.valorMedDiaAntes
          .plus(decisao.valorCandidata)
          .toFixed(2)}::numeric,
        atualizado_em = NOW()
      WHERE usuario_id = ${input.usuarioId}
    `;

    this.logger.log(
      `MED auto aplicado tx=${decisao.candidataId} usuario=${input.usuarioId} offset=${novoOffset}`,
    );
    return { aplicado: true, motivo: 'aplicado' };
  }

  /** @returns true se débito + MED foram aplicados nesta chamada. */
  private async aplicarMedNaCandidata(input: {
    usuarioId: bigint;
    candidataId: bigint;
    valor: Decimal;
    dia: string;
  }): Promise<boolean> {
    const tx = await this.prisma.transacao.findUniqueOrThrow({
      where: { id: input.candidataId },
    });
    if (tx.situacao !== SITUACAO_TRANSACAO.CONCLUIDA || tx.medAutomatico) {
      return false;
    }

    const cfg = await this.configPix.resolverEfetiva(input.usuarioId);
    const chave = `auto:${tx.id}:${input.dia}`;

    const existente = await this.prisma.casoMed.findUnique({
      where: { chaveIdempotencia: chave },
    });
    if (existente) return false;

    let caso;
    try {
      caso = await this.prisma.casoMed.create({
        data: {
          usuarioId: input.usuarioId,
          transacaoId: tx.id,
          contaProvedorId: tx.contaProvedorId,
          identificadorMedProvedor: chave,
          chaveIdempotencia: chave,
          valorSolicitado: input.valor.toFixed(2),
          modoTratamentoAplicado: 'DEBITAR_IMEDIATAMENTE',
          valorDebitado: input.valor.toFixed(2),
          situacao: SITUACAO_CASO_MED.DEBITADO,
          motivo: 'MED automático',
          decididoEm: new Date(),
          encerradoEm: new Date(),
          historicos: {
            create: {
              novaSituacao: SITUACAO_CASO_MED.DEBITADO,
              acao: 'MED_AUTOMATICO',
              origem: 'MED_AUTOMATICO',
              motivo: 'Conversão automática de venda de ontem',
            },
          },
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false;
      }
      throw e;
    }

    const ledgerResult = await this.ledger.aplicarMovimentacoes({
      usuarioId: input.usuarioId,
      permiteSaldoNegativo: cfg.permiteSaldoNegativo,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'DEBITO_MED',
          valor: input.valor,
          chaveIdempotencia: `medauto:deb:${tx.id}`,
          casoMedId: caso.id,
          transacaoId: tx.id,
          descricao: 'Débito MED automático',
        },
      ],
      outbox: {
        tipoAgregado: 'DEVOLUCAO_PIX',
        identificadorAgregado: tx.idTransacaoPublico,
        tipoEvento: EVENTOS_LOJISTA.PIX_DEVOLUCAO_CONCLUIDA,
        conteudo: {
          idTransacao: tx.idTransacaoPublico,
          valor: input.valor.toFixed(2),
          motivo: 'MED automático',
          medAutomatico: true,
        },
      },
    });

    await this.prisma.$transaction(async (db) => {
      await db.transacao.update({
        where: { id: tx.id },
        data: {
          situacao: SITUACAO_TRANSACAO.MED,
          medAutomatico: true,
          primeiroMedRecebidoEm: tx.primeiroMedRecebidoEm ?? new Date(),
        },
      });
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.MED,
          origem: 'MED_AUTOMATICO',
          motivo: 'MED automático',
        },
      });
      await db.casoMed.update({
        where: { id: caso.id },
        data: { situacao: SITUACAO_CASO_MED.ACEITO },
      });
    });

    if (ledgerResult.outboxId) {
      await this.queues.enqueueOutbox({
        eventoOutboxId: ledgerResult.outboxId.toString(),
        identificadorRastreio: `med-auto:${tx.id}`,
      });
    }

    return true;
  }

  private async persistirEstado(
    tx: Prisma.TransactionClient,
    estado: {
      usuarioId: bigint;
      hoje: string;
      offsetAtual: number;
      valorMedDia: Decimal;
    },
  ) {
    await tx.$executeRaw`
      UPDATE estados_med_automatico_usuario
      SET
        offset_atual = ${estado.offsetAtual},
        data_referencia_dia = ${estado.hoje}::date,
        valor_med_aplicado_dia = ${estado.valorMedDia.toFixed(2)}::numeric,
        atualizado_em = NOW()
      WHERE usuario_id = ${estado.usuarioId}
    `;
  }
}
