import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import {
  EVENTOS_LOJISTA,
  money,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  SITUACAO_WEBHOOK_RECEBIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';

@Processor(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED_CASHOUT)
@Injectable()
export class PixWebhookCashoutProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookCashoutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly ledger: LedgerService,
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
    const tentativa = await this.resolverTentativa(body, liquidanteId, provider);
    if (!tentativa) throw new Error('Tx cash-out não encontrada');
    const tx = tentativa.transacao;

    // Recupera o vínculo se o worker morreu entre o aceite e o update.
    if (liquidanteId && !tentativa.idTransacaoLiquidante) {
      await this.prisma.tentativaTransacao.update({
        where: { id: tentativa.id },
        data: {
          idTransacaoLiquidante: liquidanteId,
          situacao: SITUACAO_TENTATIVA.SUCESSO,
          concluidoEm: tentativa.concluidoEm ?? new Date(),
        },
      });
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
      idTransacaoLiquidante: liquidanteId || tentativa.idTransacaoLiquidante || undefined,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      credenciais,
    });

    /**
     * Máquina de estados — estados terminais não mudam de direção.
     * FALHA→CONCLUIDA sem re-débito = perda da VPay; CONCLUIDA→FALHA+estorno
     * = crédito indevido ao lojista.
     */
    if (tx.situacao === SITUACAO_TRANSACAO.CONCLUIDA) {
      if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(remote.status)) {
        this.logger.error(
          `cash-out tx=${tx.id} já CONCLUIDA mas liquidante reporta ${remote.status} — ` +
            'NÃO estorna; reconciliação manual',
        );
      }
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return { ok: true, ignorado: true, motivo: 'já CONCLUIDA' };
    }

    if (tx.situacao === SITUACAO_TRANSACAO.FALHA) {
      if (['PAID', 'COMPLETED'].includes(remote.status)) {
        this.logger.error(
          `cash-out tx=${tx.id} já FALHA (possível estorno) mas liquidante reporta ${remote.status} — ` +
            'NÃO promove a CONCLUIDA sem re-hold; reconciliação manual',
        );
      }
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return { ok: true, ignorado: true, motivo: 'já FALHA' };
    }

    if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(remote.status)) {
      this.logger.warn(
        `cash-out tx=${tx.id} confirmado como ${remote.status} pela liquidante — encerrando em FALHA`,
      );
      await this.encerrarComoFalha(tx, remote.status, webhookRecebidoId);
      return { ok: true, falhou: true, status: remote.status };
    }

    if (!['PAID', 'COMPLETED'].includes(remote.status)) {
      throw new Error(`Camada1 cash-out não confirmou: ${remote.status}`);
    }

    const atualizado = await this.prisma.transacao.updateMany({
      where: {
        id: tx.id,
        situacao: {
          in: [SITUACAO_TRANSACAO.PROCESSANDO, SITUACAO_TRANSACAO.PENDENTE],
        },
      },
      data: {
        situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        liquidadoEm: remote.paidAt ?? new Date(),
        concluidoEm: new Date(),
      },
    });
    if (atualizado.count === 0) {
      this.logger.warn(
        `cash-out tx=${tx.id} race: situação mudou antes do CONCLUIDA — ignorado`,
      );
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return { ok: true, ignorado: true, motivo: 'situação não enviável' };
    }

    await this.prisma.$transaction([
      this.prisma.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.CONCLUIDA,
          origem: 'WEBHOOK_PROVEDOR',
          motivo: 'Cash-out confirmado Camada1',
        },
      }),
      this.prisma.eventoOutbox.create({
        data: {
          usuarioId: tx.usuarioId,
          tipoAgregado: 'TRANSACAO',
          identificadorAgregado: tx.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_CASHOUT_CONCLUIDO,
          conteudo: {
            idTransacao: tx.idTransacaoPublico,
            situacao: SITUACAO_TRANSACAO.CONCLUIDA,
            valorBruto: tx.valorBruto.toString(),
          },
        },
      }),
      ...(webhookRecebidoId
        ? [
            this.prisma.webhookRecebidoProvedor.update({
              where: { id: BigInt(webhookRecebidoId) },
              data: {
                situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
                processadoEm: new Date(),
                usuarioId: tx.usuarioId,
              },
            }),
          ]
        : []),
    ]);

    return { ok: true };
  }

  /**
   * Casa pelo id liquidante; se ainda não gravamos (crash pós-aceite), tenta
   * pela `externaRef` / id privado que mandamos no createCashOut.
   */
  private async resolverTentativa(
    body: Record<string, unknown>,
    liquidanteId: string,
    provider: string,
  ) {
    const include = {
      transacao: { include: { contaProvedor: { include: { provedor: true } } } },
    } as const;

    if (liquidanteId) {
      const porId = await this.prisma.tentativaTransacao.findFirst({
        where: { idTransacaoLiquidante: liquidanteId },
        include,
      });
      if (porId) {
        if (porId.transacao.contaProvedor?.provedor.codigo !== provider) {
          throw new Error('Mismatch provedor cash-out');
        }
        return porId;
      }
    }

    const refPrivada = String(
      body.externaRef ??
        body.externalRef ??
        body.externa_ref ??
        body.metadata ??
        '',
    ).trim();
    if (!refPrivada) return null;

    const porRef = await this.prisma.tentativaTransacao.findFirst({
      where: {
        transacao: { idTransacaoPrivado: refPrivada, direcao: 'SAIDA' },
        situacao: { in: [SITUACAO_TENTATIVA.ENVIANDO, SITUACAO_TENTATIVA.SUCESSO] },
      },
      include,
      orderBy: { id: 'desc' },
    });
    if (!porRef) return null;
    if (porRef.transacao.contaProvedor?.provedor.codigo !== provider) {
      throw new Error('Mismatch provedor cash-out');
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

  /**
   * Saque que a liquidante confirmou como falho. Mesma forma do caminho
   * síncrono (`PixCashOutProcessor.registrarRecusa`): transação em FALHA,
   * histórico registrando que o saldo NÃO voltou, e callback ao lojista — tudo
   * numa transação só.
   */
  private async encerrarComoFalha(
    tx: {
      id: bigint;
      usuarioId: bigint;
      idTransacaoPublico: string;
      situacao: string;
      valorBruto: Prisma.Decimal;
      valorTarifaPix: Prisma.Decimal;
    },
    statusRemoto: string,
    webhookRecebidoId?: string,
  ) {
    /**
     * Estorno + FALHA + histórico + outbox no MESMO commit.
     *
     * A liquidante CONFIRMOU que o PIX não saiu, então o valor volta para o
     * lojista poder tentar de novo. TUDO atômico de propósito: se o estorno
     * (`aplicarMovimentacoes`) falhar por um blip de banco/deadlock, a
     * transação inteira reverte — a tx CONTINUA `PROCESSANDO` e o retry do
     * BullMQ refaz do zero. Antes, o claim para FALHA commitava sozinho e o
     * estorno vinha depois: um erro no meio deixava FALHA sem crédito, e o
     * retry batia no guard de "já FALHA" e nunca refazia o estorno — dinheiro
     * do lojista preso sem recuperação. Aqui é SEGURO ser atômico (diferente da
     * recusa síncrona `registrarRecusa`, que estorna antes num commit próprio):
     * o saque FOI enviado e tem `idTransacaoLiquidante`, então se este commit
     * reverter a conciliação reencontra a tx em PROCESSANDO, consulta a
     * liquidante e refaz — há rede de recuperação.
     *
     * As chaves são as MESMAS de `PixCashOutProcessor.estornarSaque` — se a
     * recusa síncrona já tiver estornado, o dedupe do ledger torna isto no-op.
     */
    const valor = money(tx.valorBruto.toString());
    const tarifa = money(tx.valorTarifaPix.toString());
    const entries = [
      {
        tipoSaldo: 'DISPONIVEL' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'ESTORNO_SAQUE' as const,
        valor,
        chaveIdempotencia: `saque:estorno:${tx.id}`,
        transacaoId: tx.id,
        descricao: `Estorno de saque — liquidante confirmou ${statusRemoto}`.slice(0, 500),
      },
    ];
    if (tarifa.gt(0)) {
      entries.push({
        tipoSaldo: 'DISPONIVEL' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'ESTORNO_SAQUE' as const,
        valor: tarifa,
        chaveIdempotencia: `saque:estorno-tarifa:${tx.id}`,
        transacaoId: tx.id,
        descricao: 'Estorno da tarifa de saque não executado',
      });
    }

    const estornado = await this.prisma.$transaction(async (db) => {
      // O claim vive DENTRO da transação: se não pegar (já não estava
      // PROCESSANDO), aborta sem estornar — outro caminho já resolveu.
      const claim = await db.transacao.updateMany({
        where: {
          id: tx.id,
          situacao: {
            in: [SITUACAO_TRANSACAO.PROCESSANDO, SITUACAO_TRANSACAO.PENDENTE],
          },
        },
        data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
      });
      if (claim.count === 0) return false;

      await this.ledger.aplicarMovimentacoes({ usuarioId: tx.usuarioId, entries }, db);

      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.FALHA,
          origem: 'WEBHOOK_PROVEDOR',
          motivo: `Liquidante confirmou o cash-out como ${statusRemoto}`,
          metadados: { saldoDevolvido: true, estorno: 'automatico' },
        },
      });
      await db.eventoOutbox.create({
        data: {
          usuarioId: tx.usuarioId,
          tipoAgregado: 'TRANSACAO',
          identificadorAgregado: tx.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_CASHOUT_FALHOU,
          conteudo: {
            idTransacao: tx.idTransacaoPublico,
            situacao: SITUACAO_TRANSACAO.FALHA,
            motivo: `Liquidante confirmou o cash-out como ${statusRemoto}`,
          },
        },
      });
      if (webhookRecebidoId) {
        await db.webhookRecebidoProvedor.update({
          where: { id: BigInt(webhookRecebidoId) },
          data: {
            situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
            processadoEm: new Date(),
            usuarioId: tx.usuarioId,
          },
        });
      }
      return true;
    });

    if (!estornado) {
      this.logger.warn(
        `cash-out tx=${tx.id} não estava PROCESSANDO — estorno de webhook ignorado`,
      );
      await this.marcarWebhookProcessado(webhookRecebidoId, tx.usuarioId);
      return;
    }
    this.logger.log(`saque tx=${tx.id} estornado após confirmação de ${statusRemoto}`);
  }
}
