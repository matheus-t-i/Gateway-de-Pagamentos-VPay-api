import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  money,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  SITUACAO_WEBHOOK_RECEBIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';
import { CashInCreditoService } from '../retencao/cashin-credito.service';
import { RetencaoMetodoService } from '../retencao/retencao-metodo.service';
import {
  assertValorCamada1Compativel,
  extrairValorDePayload,
} from '../providers/valor-remoto.util';

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
    // liquidanteId pode vir vazio no recovery só por externaRef (raro); ainda assim
    // tentamos resolver. Camada 1 exige id depois.
    const tentativa = await this.resolverTentativa(body, liquidanteId, provider);
    if (!tentativa) {
      throw new Error(
        `Tx local não encontrada para liquidante ${liquidanteId || '(vazio)'} ` +
          `(nem por externaRef)`,
      );
    }

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

    // Recovery: gravamos o id liquidante que faltava (crash/TIMEOUT fantasma).
    const idLiquidanteEfetivo =
      liquidanteId || tentativa.idTransacaoLiquidante || '';
    if (
      idLiquidanteEfetivo &&
      !tentativa.idTransacaoLiquidante
    ) {
      await this.prisma.tentativaTransacao.update({
        where: { id: tentativa.id },
        data: { idTransacaoLiquidante: idLiquidanteEfetivo },
      });
    }

    if (
      (
        [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA] as string[]
      ).includes(tx.situacao) ||
      tx.retidaMetodo
    ) {
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return { ok: true, duplicated: true };
    }

    const statusEvent = String(body.status ?? '').toUpperCase();
    if (!['PAID', 'COMPLETED', 'PAGO', 'CONCLUIDO', 'LIQUIDADA'].includes(statusEvent)) {
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return { ok: true, ignored: true, status: statusEvent };
    }

    if (!idLiquidanteEfetivo) {
      throw new Error('Camada1: sem idTransacaoLiquidante para consultar status');
    }

    const credenciais = decryptCredentials(
      tx.contaProvedor!.credenciaisCriptografadas,
    );
    const remote = await this.providers.get(provider).getStatus({
      idTransacaoLiquidante: idLiquidanteEfetivo,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      credenciais,
    });
    if (!['PAID', 'COMPLETED'].includes(remote.status)) {
      throw new Error(`Camada1 não confirmou pagamento: ${remote.status}`);
    }

    const valorRemoto =
      remote.valor ?? extrairValorDePayload(body) ?? extrairValorDePayload(remote.raw);
    assertValorCamada1Compativel(money(tx.valorBruto.toString()), valorRemoto);

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

  /**
   * Casa pelo id liquidante; se ainda não gravamos (TIMEOUT/crash pós-aceite),
   * tenta pela externaRef / id privado / referência externa / metadata pública.
   */
  private async resolverTentativa(
    body: Record<string, unknown>,
    liquidanteId: string,
    provider: string,
  ) {
    const include = {
      transacao: {
        include: {
          contaProvedor: { include: { provedor: true } },
          pix: true,
          usuario: { include: { configuracaoPix: true } },
        },
      },
    } as const;

    if (liquidanteId) {
      const porId = await this.prisma.tentativaTransacao.findFirst({
        where: { idTransacaoLiquidante: liquidanteId },
        include,
        orderBy: { criadoEm: 'desc' },
      });
      if (porId) {
        if (porId.transacao.contaProvedor?.provedor.codigo !== provider) {
          throw new Error('Mismatch provedor vs transação local');
        }
        return porId;
      }
    }

    const ref = String(
      body.externaRef ??
        body.externalRef ??
        body.externa_ref ??
        body.external_reference ??
        body.metadata ??
        '',
    ).trim();
    if (!ref) return null;

    // Preferência: id privado (nosso) — é o que mandamos quando não há
    // referenciaExterna do lojista.
    const porPrivado = await this.prisma.tentativaTransacao.findFirst({
      where: {
        transacao: {
          idTransacaoPrivado: ref,
          direcao: 'ENTRADA',
        },
      },
      include,
      orderBy: { id: 'desc' },
    });
    if (porPrivado) {
      if (porPrivado.transacao.contaProvedor?.provedor.codigo !== provider) {
        throw new Error('Mismatch provedor vs transação local');
      }
      return porPrivado;
    }

    // Fallback: referenciaExterna do lojista ou id público (metadata Valorion).
    // Só candidatos ainda creditáveis (não terminais de sucesso).
    const porRef = await this.prisma.tentativaTransacao.findFirst({
      where: {
        situacao: { in: [SITUACAO_TENTATIVA.SUCESSO, SITUACAO_TENTATIVA.FALHA] },
        transacao: {
          direcao: 'ENTRADA',
          situacao: {
            in: [
              SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
              SITUACAO_TRANSACAO.FALHA,
              SITUACAO_TRANSACAO.PENDENTE,
            ],
          },
          OR: [{ referenciaExterna: ref }, { idTransacaoPublico: ref }],
        },
      },
      include,
      orderBy: { id: 'desc' },
    });
    if (!porRef) return null;
    if (porRef.transacao.contaProvedor?.provedor.codigo !== provider) {
      throw new Error('Mismatch provedor vs transação local');
    }
    return porRef;
  }

  private async marcarWebhookProcessado(
    webhookRecebidoId: string | undefined,
    usuarioId: bigint,
  ) {
    if (!webhookRecebidoId) return;
    await this.prisma.webhookRecebidoProvedor.update({
      where: { id: BigInt(webhookRecebidoId) },
      data: {
        situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
        processadoEm: new Date(),
        usuarioId,
      },
    });
  }
}
