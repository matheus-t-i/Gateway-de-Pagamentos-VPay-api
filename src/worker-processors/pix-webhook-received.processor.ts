import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  money,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';
import { CashInCreditoService } from '../retencao/cashin-credito.service';
import { RetencaoMetodoService } from '../retencao/retencao-metodo.service';

@Processor(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED)
@Injectable()
export class PixWebhookReceivedProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookReceivedProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly retencao: RetencaoMetodoService,
    private readonly credito: CashInCreditoService,
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
          include: {
            contaProvedor: { include: { provedor: true } },
            pix: true,
            usuario: { include: { configuracaoPix: true } },
          },
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
      ).includes(tx.situacao) ||
      tx.retidaMetodo
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

    const cfgUsuario = tx.usuario.configuracaoPix;
    const decisao = await this.retencao.decidir({
      valorBruto: money(tx.valorBruto.toString()),
      nomePagador: tx.pix?.nomePagador,
      emailPagador: tx.pix?.emailPagador,
      percentualContaAdquirente: tx.contaProvedor?.percentualRetencaoMetodo
        ? money(tx.contaProvedor.percentualRetencaoMetodo.toString())
        : null,
      retencaoMetodoAtivoCliente: cfgUsuario?.retencaoMetodoAtivo ?? false,
      percentualRetencaoCliente: money(
        cfgUsuario?.percentualRetencaoMetodo?.toString() ?? '0',
      ),
    });

    if (decisao.reter) {
      return this.credito.marcarRetida({
        transacaoId: tx.id,
        endToEndId: remote.endToEndId,
        liquidadoEm: remote.paidAt ?? new Date(),
        webhookRecebidoId,
        motivo: `Método de retenção: ${decisao.motivo}`,
      });
    }

    return this.credito.creditar({
      transacaoId: tx.id,
      endToEndId: remote.endToEndId,
      liquidadoEm: remote.paidAt ?? new Date(),
      origem: 'WEBHOOK_PROVEDOR',
      motivo: `Confirmado Camada1 (${decisao.motivo})`,
      webhookRecebidoId,
      identificadorRastreio,
    });
  }
}
