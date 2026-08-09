import { Injectable, Logger } from '@nestjs/common';
import {
  EVENTOS_LOJISTA,
  money,
  SITUACAO_LIBERACAO,
  SITUACAO_TRANSACAO,
  SITUACAO_WEBHOOK_RECEBIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { BloqueiosSaldoService } from '../ledger/bloqueios-saldo.service';
import { QueuesService } from '../queues/queues.service';
import { MedAutomaticoService } from '../med/med-automatico.service';

export type CreditarCashInInput = {
  transacaoId: bigint;
  /** endToEnd da liquidante (opcional na liberação manual se já gravado). */
  endToEndId?: string | null;
  liquidadoEm?: Date | null;
  /** Origem do histórico de situação. */
  origem: string;
  motivo: string;
  webhookRecebidoId?: string | null;
  identificadorRastreio?: string;
};

/**
 * Único caminho de crédito cash-in após confirmação na liquidante
 * (webhook) ou liberação manual de venda retida pelo método.
 */
@Injectable()
export class CashInCreditoService {
  private readonly logger = new Logger(CashInCreditoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly configPix: ConfigPixService,
    private readonly bloqueios: BloqueiosSaldoService,
    private readonly queues: QueuesService,
    private readonly medAutomatico: MedAutomaticoService,
  ) {}

  async creditar(input: CreditarCashInInput) {
    const tx = await this.prisma.transacao.findUniqueOrThrow({
      where: { id: input.transacaoId },
      include: { pix: true },
    });

    if (
      (
        [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA] as string[]
      ).includes(tx.situacao)
    ) {
      return { ok: true as const, duplicated: true as const };
    }

    const cfg = await this.configPix.resolverEfetiva(tx.usuarioId);
    const valorReserva = money(tx.valorReserva.toString());
    const valorLiquido = money(tx.valorLiquidacaoEmpresa.toString());
    const valorPrincipal = valorLiquido.minus(valorReserva);

    const entries: {
      tipoSaldo: 'PENDENTE_LIBERACAO' | 'DISPONIVEL' | 'RESERVADO';
      tipoMovimento: 'CREDITO';
      natureza: 'RECEBIMENTO' | 'RESERVA';
      valor: ReturnType<typeof money>;
      chaveIdempotencia: string;
      transacaoId: bigint;
      descricao: string;
    }[] = [];
    if (cfg.diasLiberacaoSaldo > 0) {
      entries.push({
        tipoSaldo: 'PENDENTE_LIBERACAO' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'RECEBIMENTO' as const,
        valor: valorPrincipal,
        chaveIdempotencia: `cashin:pendente:${tx.id}`,
        transacaoId: tx.id,
        descricao: 'Crédito pendente liberação',
      });
    } else {
      entries.push({
        tipoSaldo: 'DISPONIVEL' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'RECEBIMENTO' as const,
        valor: valorPrincipal,
        chaveIdempotencia: `cashin:disp:${tx.id}`,
        transacaoId: tx.id,
        descricao: 'Crédito disponível cash-in',
      });
    }
    if (valorReserva.gt(0)) {
      entries.push({
        tipoSaldo: 'RESERVADO' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'RESERVA' as const,
        valor: valorReserva,
        chaveIdempotencia: `cashin:reserva:${tx.id}`,
        transacaoId: tx.id,
        descricao: 'Reserva cash-in',
      });
    }

    const liquidadoEm = input.liquidadoEm ?? tx.liquidadoEm ?? new Date();
    let outboxId: bigint | undefined;
    let duplicated = false;

    /**
     * Um único commit: FOR UPDATE na tx + ledger + CONCLUIDA + outbox.
     * Antes o ledger commitava sozinho e a situação vinha depois — crash no
     * meio deixava saldo creditado com painel ainda AGUARDANDO, e retry
     * gerava segundo outbox.
     */
    await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`
        SELECT id FROM transacoes WHERE id = ${tx.id} FOR UPDATE
      `;
      const atual = await db.transacao.findUniqueOrThrow({
        where: { id: tx.id },
      });
      if (
        (
          [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA] as string[]
        ).includes(atual.situacao)
      ) {
        duplicated = true;
        return;
      }

      const ledgerResult = await this.ledger.aplicarMovimentacoes(
        {
          usuarioId: tx.usuarioId,
          permiteSaldoNegativo: cfg.permiteSaldoNegativo,
          entries,
          outbox: {
            tipoAgregado: 'TRANSACAO',
            identificadorAgregado: tx.idTransacaoPublico,
            tipoEvento: EVENTOS_LOJISTA.PIX_CASHIN_PAGO,
            conteudo: {
              idTransacao: tx.idTransacaoPublico,
              situacao: SITUACAO_TRANSACAO.LIQUIDADA,
              valorBruto: tx.valorBruto.toString(),
            },
          },
        },
        db,
      );
      outboxId = ledgerResult.outboxId;

      await db.transacao.update({
        where: { id: tx.id },
        data: {
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          liquidadoEm,
          concluidoEm: new Date(),
        },
      });
      if (input.endToEndId) {
        await db.transacaoPix.update({
          where: { transacaoId: tx.id },
          data: { identificadorFimAFim: input.endToEndId },
        });
      }
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: atual.situacao,
          novaSituacao: SITUACAO_TRANSACAO.CONCLUIDA,
          origem: input.origem,
          motivo: input.motivo,
        },
      });
      if (input.webhookRecebidoId) {
        await db.webhookRecebidoProvedor.update({
          where: { id: BigInt(input.webhookRecebidoId) },
          data: {
            situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
            processadoEm: new Date(),
            usuarioId: tx.usuarioId,
          },
        });
      }
      if (cfg.diasLiberacaoSaldo > 0) {
        await db.liberacaoSaldo.upsert({
          where: {
            transacaoId_tipoLiberacao: {
              transacaoId: tx.id,
              tipoLiberacao: 'SALDO_PRINCIPAL',
            },
          },
          create: {
            usuarioId: tx.usuarioId,
            transacaoId: tx.id,
            tipoLiberacao: 'SALDO_PRINCIPAL',
            valor: valorPrincipal.toFixed(2),
            liberarEm: tx.liberarSaldoEm ?? new Date(),
            situacao: SITUACAO_LIBERACAO.AGENDADA,
          },
          update: {},
        });
      }
      if (valorReserva.gt(0) && tx.liberarReservaEm) {
        await db.liberacaoSaldo.upsert({
          where: {
            transacaoId_tipoLiberacao: {
              transacaoId: tx.id,
              tipoLiberacao: 'RESERVA',
            },
          },
          create: {
            usuarioId: tx.usuarioId,
            transacaoId: tx.id,
            tipoLiberacao: 'RESERVA',
            valor: valorReserva.toFixed(2),
            liberarEm: tx.liberarReservaEm,
            situacao: SITUACAO_LIBERACAO.AGENDADA,
          },
          update: {},
        });
      }
    });

    if (duplicated) {
      return { ok: true as const, duplicated: true as const };
    }

    if (cfg.diasLiberacaoSaldo === 0) {
      await this.bloqueios.capturarSemFalhar(tx.usuarioId, `cashin:${tx.id}`);
    }

    if (outboxId) {
      await this.queues.enqueueOutbox({
        eventoOutboxId: outboxId.toString(),
        identificadorRastreio:
          input.identificadorRastreio ?? `cashin-credito:${tx.id}`,
      });
    }

    this.logger.log(`cash-in creditado tx=${tx.id} origem=${input.origem}`);

    // MED automático: só depois do crédito. Falha sobe no job (ledger do cash-in
    // já é idempotente no retry).
    await this.medAutomatico.avaliar({
      usuarioId: tx.usuarioId,
      transacaoAtualId: tx.id,
      valorBrutoAtual: money(tx.valorBruto.toString()),
    });

    return { ok: true as const, transacaoId: tx.id.toString() };
  }

  /**
   * Marca a venda como retida pelo método: paga na liquidante, sem crédito
   * nem callback. Situação permanece AGUARDANDO_PAGAMENTO.
   */
  async marcarRetida(input: {
    transacaoId: bigint;
    endToEndId?: string | null;
    liquidadoEm?: Date | null;
    webhookRecebidoId?: string | null;
    motivo: string;
  }) {
    const tx = await this.prisma.transacao.findUniqueOrThrow({
      where: { id: input.transacaoId },
    });

    if (tx.retidaMetodo) {
      return { ok: true as const, duplicated: true as const };
    }
    if (
      (
        [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA] as string[]
      ).includes(tx.situacao)
    ) {
      throw new Error('Transação já concluída — não pode reter');
    }

    await this.prisma.$transaction(async (db) => {
      await db.transacao.update({
        where: { id: tx.id },
        data: {
          retidaMetodo: true,
          liquidadoEm: input.liquidadoEm ?? new Date(),
        },
      });
      if (input.endToEndId) {
        await db.transacaoPix.update({
          where: { transacaoId: tx.id },
          data: { identificadorFimAFim: input.endToEndId },
        });
      }
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: tx.situacao,
          origem: 'RETENCAO_METODO',
          motivo: input.motivo,
        },
      });
      if (input.webhookRecebidoId) {
        await db.webhookRecebidoProvedor.update({
          where: { id: BigInt(input.webhookRecebidoId) },
          data: {
            situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
            processadoEm: new Date(),
            usuarioId: tx.usuarioId,
          },
        });
      }
    });

    this.logger.log(`cash-in RETIDO metodo tx=${tx.id}`);
    return { ok: true as const, retida: true as const, transacaoId: tx.id.toString() };
  }
}
