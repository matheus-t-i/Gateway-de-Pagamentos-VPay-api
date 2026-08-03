import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
  SITUACAO_WEBHOOK_RECEBIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';

@Processor(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED_CASHOUT)
@Injectable()
export class PixWebhookCashoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookCashoutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const { provider, payload, webhookRecebidoId } = job.data;
    this.logger.log(`cash-out webhook provider=${provider}`);

    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo: provider },
    });
    if (!provedor || provedor.situacao !== SITUACAO_PROVEDOR.ATIVO) {
      throw new Error(`Provedor inativo/ausente: ${provider}`);
    }

    const body = payload as Record<string, unknown>;
    const liquidanteId = String(body.transactionId ?? body.idTransacaoLiquidante ?? '');
    const tentativa = await this.prisma.tentativaTransacao.findFirst({
      where: { idTransacaoLiquidante: liquidanteId },
      include: {
        transacao: { include: { contaProvedor: { include: { provedor: true } } } },
      },
    });
    if (!tentativa) throw new Error('Tx cash-out não encontrada');
    const tx = tentativa.transacao;
    if (tx.contaProvedor?.provedor.codigo !== provider) {
      throw new Error('Mismatch provedor cash-out');
    }

    const statusEvent = String(body.status ?? '').toUpperCase();
    if (!['PAID', 'COMPLETED', 'CONCLUIDO'].includes(statusEvent)) {
      return { ok: true, ignored: true };
    }

    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(tx.contaProvedor!.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(tx.contaProvedor!.credenciaisCriptografadas);
    }
    const remote = await this.providers.get(provider).getStatus({
      idTransacaoLiquidante: liquidanteId,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      credenciais,
    });
    if (!['PAID', 'COMPLETED'].includes(remote.status)) {
      throw new Error(`Camada1 cash-out não confirmou: ${remote.status}`);
    }

    await this.prisma.$transaction([
      this.prisma.transacao.update({
        where: { id: tx.id },
        data: {
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          liquidadoEm: remote.paidAt ?? new Date(),
          concluidoEm: new Date(),
        },
      }),
      this.prisma.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.CONCLUIDA,
          origem: 'WEBHOOK_PROVEDOR',
          motivo: 'Cash-out confirmado Camada1',
        },
      }),
      ...(webhookRecebidoId
        ? [
            this.prisma.webhookRecebidoProvedor.update({
              where: { id: BigInt(webhookRecebidoId) },
              data: {
                situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
                processadoEm: new Date(),
                empresaId: tx.empresaId,
              },
            }),
          ]
        : []),
    ]);

    return { ok: true };
  }
}
