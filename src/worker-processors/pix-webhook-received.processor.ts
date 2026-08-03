import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  EVENTOS_LOJISTA,
  money,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_LIBERACAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
  SITUACAO_WEBHOOK_RECEBIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { QueuesService } from '../queues/queues.service';
import { decryptCredentials } from '../common/crypto.util';

@Processor(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED)
@Injectable()
export class PixWebhookReceivedProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookReceivedProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly ledger: LedgerService,
    private readonly configPix: ConfigPixService,
    private readonly queues: QueuesService,
  ) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const { provider, payload, webhookRecebidoId, identificadorRastreio } = job.data;
    this.logger.log(`cash-in webhook provider=${provider} rastreio=${identificadorRastreio}`);

    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo: provider },
    });
    if (!provedor || provedor.situacao !== SITUACAO_PROVEDOR.ATIVO) {
      throw new Error(`Provedor inativo/ausente: ${provider}`);
    }

    const body = payload as Record<string, unknown>;
    const liquidanteId = String(body.transactionId ?? body.idTransacaoLiquidante ?? '');
    if (!liquidanteId) throw new Error('Payload sem transactionId');

    const tentativa = await this.prisma.tentativaTransacao.findFirst({
      where: { idTransacaoLiquidante: liquidanteId },
      include: {
        transacao: {
          include: { contaProvedor: { include: { provedor: true } }, pix: true },
        },
      },
      orderBy: { criadoEm: 'desc' },
    });
    if (!tentativa) throw new Error(`Tx local não encontrada para liquidante ${liquidanteId}`);

    const tx = tentativa.transacao;
    if (tx.contaProvedor?.provedor.codigo !== provider) {
      throw new Error('Mismatch provedor vs transação local');
    }
    if (
      body.contaProvedorId &&
      String(body.contaProvedorId) !== tx.contaProvedorId?.toString()
    ) {
      throw new Error('Mismatch conta_provedor');
    }

    if (
      (
        [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA] as string[]
      ).includes(tx.situacao)
    ) {
      return { ok: true, duplicated: true };
    }

    const statusEvent = String(body.status ?? '').toUpperCase();
    if (!['PAID', 'COMPLETED', 'PAGO', 'CONCLUIDO', 'LIQUIDADA'].includes(statusEvent)) {
      return { ok: true, ignored: true, status: statusEvent };
    }

    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(tx.contaProvedor!.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(tx.contaProvedor!.credenciaisCriptografadas) as Record<
        string,
        unknown
      >;
    }
    const remote = await this.providers.get(provider).getStatus({
      idTransacaoLiquidante: liquidanteId,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      credenciais,
    });
    if (!['PAID', 'COMPLETED'].includes(remote.status)) {
      throw new Error(`Camada1 não confirmou pagamento: ${remote.status}`);
    }

    const cfg = await this.configPix.resolverEfetiva(tx.empresaId);
    const valorReserva = money(tx.valorReserva.toString());
    const valorLiquido = money(tx.valorLiquidacaoEmpresa.toString());
    const valorPrincipal = valorLiquido.minus(valorReserva);

    const entries = [];
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

    const ledgerResult = await this.ledger.aplicarMovimentacoes({
      empresaId: tx.empresaId,
      permiteSaldoNegativo: cfg.permiteSaldoNegativo,
      entries,
      outbox: {
        tipoAgregado: 'TRANSACAO',
        identificadorAgregado: tx.idTransacaoPublico,
        tipoEvento: EVENTOS_LOJISTA.PIX_CASHIN_PAGO,
        conteudo: {
          // Público: sempre "idTransacao" (nunca expor a ideia de id público vs
          // interno). Coerente com o callback de devolução.
          idTransacao: tx.idTransacaoPublico,
          situacao: SITUACAO_TRANSACAO.LIQUIDADA,
          valorBruto: tx.valorBruto.toString(),
        },
      },
    });

    await this.prisma.$transaction(async (db) => {
      await db.transacao.update({
        where: { id: tx.id },
        data: {
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          liquidadoEm: remote.paidAt ?? new Date(),
          concluidoEm: new Date(),
        },
      });
      await db.transacaoPix.update({
        where: { transacaoId: tx.id },
        data: { identificadorFimAFim: remote.endToEndId },
      });
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.CONCLUIDA,
          origem: 'WEBHOOK_PROVEDOR',
          motivo: 'Confirmado Camada1',
        },
      });
      if (webhookRecebidoId) {
        await db.webhookRecebidoProvedor.update({
          where: { id: BigInt(webhookRecebidoId) },
          data: {
            situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
            processadoEm: new Date(),
            empresaId: tx.empresaId,
          },
        });
      }
      if (cfg.diasLiberacaoSaldo > 0) {
        await db.liberacaoSaldo.create({
          data: {
            empresaId: tx.empresaId,
            transacaoId: tx.id,
            tipoLiberacao: 'SALDO_PRINCIPAL',
            valor: valorPrincipal.toFixed(2),
            liberarEm: tx.liberarSaldoEm ?? new Date(),
            situacao: SITUACAO_LIBERACAO.AGENDADA,
          },
        });
      }
      if (valorReserva.gt(0) && tx.liberarReservaEm) {
        await db.liberacaoSaldo.create({
          data: {
            empresaId: tx.empresaId,
            transacaoId: tx.id,
            tipoLiberacao: 'RESERVA',
            valor: valorReserva.toFixed(2),
            liberarEm: tx.liberarReservaEm,
            situacao: SITUACAO_LIBERACAO.AGENDADA,
          },
        });
      }
    });

    // Padrão outbox: publicamos APENAS o evento; o 5-outbox-publisher é quem
    // enfileira o 2-pix-webhook-send. Enfileirar aqui também gerava entrega
    // duplicada do mesmo callback ao lojista.
    if (ledgerResult.outboxId) {
      await this.queues.enqueueOutbox({
        eventoOutboxId: ledgerResult.outboxId.toString(),
        identificadorRastreio,
      });
    }

    return { ok: true, transacaoId: tx.id.toString() };
  }
}
