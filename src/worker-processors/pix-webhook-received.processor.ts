import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
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
import { RecusaAdquirenteError } from '../providers/payment-provider.port';
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

    /**
     * `idtransaction` do postback é o id da LIQUIDANTE (gravado em
     * `tentativas_transacoes.id_transacao_liquidante` no create). Mandar o
     * nosso `id_transacao_privado` aqui é mismatch — a Valorion responde 404
     * e, sem UnrecoverableError, o BullMQ retentava 5 vezes com backoff
     * exponencial (~16s na 4ª), que parecia "delay padrão de 20s".
     */
    if (
      liquidanteId &&
      tentativa.idTransacaoLiquidante &&
      liquidanteId !== tentativa.idTransacaoLiquidante
    ) {
      throw new UnrecoverableError(
        `Mismatch id liquidante: webhook=${liquidanteId} ` +
          `tentativa=${tentativa.idTransacaoLiquidante} — idtransaction é o ` +
          `id da adquirente, não id_transacao_privado/publico`,
      );
    }

    // Recovery: gravamos o id liquidante que faltava (crash/TIMEOUT fantasma).
    // Fonte da verdade quando já existe: o id gravado no create, não o do body.
    const idLiquidanteEfetivo =
      tentativa.idTransacaoLiquidante || liquidanteId || '';
    if (idLiquidanteEfetivo && !tentativa.idTransacaoLiquidante) {
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
    let remote;
    try {
      remote = await this.providers.get(provider).getStatus({
        idTransacaoLiquidante: idLiquidanteEfetivo,
        idTransacaoPrivado: tx.idTransacaoPrivado,
        credenciais,
      });
    } catch (e) {
      // 4xx da consulta (404 transação inexistente, 401/403) não muda no retry.
      // Timeout/5xx continuam Error comum e o backoff reagenda.
      if (e instanceof RecusaAdquirenteError) {
        throw new UnrecoverableError(
          `Camada1 recusada pela liquidante: ${e.message.slice(0, 300)}`,
        );
      }
      throw e;
    }
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
        // Nome real do eco no postback Valorion (o controller já traduz para
        // `externaRef`, mas payload reprocessado à mão pode vir cru).
        body.externalreference ??
        // `metadata` objeto viraria "[object Object]" e nunca casaria.
        (typeof body.metadata === 'string' ? body.metadata : '') ??
        '',
    ).trim();
    if (!ref) return null;

    // Id privado (nosso). Hoje o `externaRef` da cobrança sai como
    // `idTransacaoPublico`, então este ramo só casa cobrança ANTIGA (criada
    // antes da troca, ainda em voo) ou payload reprocessado à mão. Mantido de
    // propósito: é o que recupera o que já está na liquidante com a chave velha.
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
    //
    // Com "nunca 409", a MESMA referência acumula N cobranças vivas — e este
    // fallback só roda quando o id liquidante do webhook não casou com nenhuma
    // tentativa. A dona do pagamento órfão é, por construção, a tentativa que
    // ficou SEM `idTransacaoLiquidante` (crash/TIMEOUT antes de gravar):
    // preferi-la evita creditar a cobrança errada e carimbar o id de um
    // pagamento na tentativa de outro. `id asc` = a mais antiga primeiro,
    // que é a que está esperando há mais tempo.
    const filtroRef = {
      situacao: {
        in: [SITUACAO_TENTATIVA.SUCESSO, SITUACAO_TENTATIVA.FALHA],
      },
      transacao: {
        direcao: 'ENTRADA' as const,
        situacao: {
          in: [
            SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
            SITUACAO_TRANSACAO.FALHA,
            SITUACAO_TRANSACAO.PENDENTE,
          ],
        },
        OR: [{ referenciaExterna: ref }, { idTransacaoPublico: ref }],
      },
    };
    const porRef =
      (await this.prisma.tentativaTransacao.findFirst({
        where: { ...filtroRef, idTransacaoLiquidante: null },
        include,
        orderBy: { id: 'asc' },
      })) ??
      (await this.prisma.tentativaTransacao.findFirst({
        where: filtroRef,
        include,
        orderBy: { id: 'asc' },
      }));
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
