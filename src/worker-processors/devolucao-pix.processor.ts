import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import {
  DevolucaoPixJobPayload,
  EVENTOS_LOJISTA,
  money,
  QUEUE_NAMES,
  SITUACAO_DEVOLUCAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  ErroAntesDoEnvioError,
  RecusaAdquirenteError,
} from '../providers/payment-provider.port';
import { ProviderRegistry } from '../providers/provider.registry';
import { QueuesService } from '../queues/queues.service';
import { decryptCredentials } from '../common/crypto.util';

/**
 * Efetiva a devolução PIX (MED aceito) na liquidante.
 *
 * O ledger já foi liquidado na decisão do caso — este passo é só a
 * transferência externa. Mas "só a transferência" é dinheiro saindo, e o refund
 * da Valorion NÃO tem chave de idempotência (`createRefund` manda apenas
 * `{ id, external_reference }`) — então os desfechos seguem a MESMA doutrina do
 * `PixCashOutProcessor`:
 *
 *  - pré-envio  → volta a PENDENTE (retentável; teto de 8 vira FALHA)
 *  - recusa     → FALHA definitiva (retry devolveria o mesmo não)
 *  - ambíguo    → AMBIGUA + congela (o refund PODE ter saído — reenviar
 *                 poderia devolver o dinheiro duas vezes)
 *
 * A retentativa de PENDENTE vem de dois lugares: o retry do BullMQ
 * (attempts: 5) e a varredura da conciliação, que reenfileira PENDENTE preso —
 * é ela que cobre enqueue perdido após o commit do `MedService.decidir`.
 * PROCESSANDO parado (worker morto no meio) NUNCA é retentado automaticamente:
 * não dá para saber se o POST saiu; fica para /admin/dinheiro-parado.
 */
@Processor(QUEUE_NAMES.DEVOLUCAO_PIX)
@Injectable()
export class DevolucaoPixProcessor extends WorkerHost {
  private readonly logger = new Logger(DevolucaoPixProcessor.name);

  /** Depois disto a linha vira FALHA e sai da varredura — decisão humana. */
  static readonly MAXIMO_TENTATIVAS = 8;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly queues: QueuesService,
  ) {
    super();
  }

  async process(job: Job<DevolucaoPixJobPayload>) {
    const { devolucaoId, identificadorRastreio } = job.data;
    this.logger.log(`devolução ${devolucaoId} rastreio=${identificadorRastreio}`);

    const devolucao = await this.prisma.devolucaoPix.findUnique({
      where: { id: BigInt(devolucaoId) },
      include: {
        transacao: {
          include: {
            contaProvedor: { include: { provedor: true } },
            tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 1 },
          },
        },
      },
    });
    if (!devolucao) {
      // A linha é criada ANTES do enqueue (mesmo commit da decisão): não
      // existir agora é id errado/apagado — retry não a faz aparecer.
      throw new UnrecoverableError(`Devolução ${devolucaoId} não encontrada`);
    }

    // Idempotência: retentativa depois de sucesso não reenvia nada.
    if (devolucao.situacao === SITUACAO_DEVOLUCAO.CONCLUIDA) {
      return { ok: true, jaConcluida: true };
    }

    /**
     * Claim: só PENDENTE entra. Serializa job duplicado (varredura + retry do
     * BullMQ apontando para a mesma linha) e garante que PROCESSANDO/AMBIGUA/
     * FALHA nunca reexecutam por acidente — reprocessar esses é decisão
     * humana, não de fila.
     */
    const claim = await this.prisma.devolucaoPix.updateMany({
      where: { id: devolucao.id, situacao: SITUACAO_DEVOLUCAO.PENDENTE },
      data: {
        situacao: SITUACAO_DEVOLUCAO.PROCESSANDO,
        quantidadeTentativas: { increment: 1 },
      },
    });
    if (claim.count !== 1) {
      this.logger.warn(
        `devolução ${devolucaoId} em ${devolucao.situacao} — claim não obtido, ignorada`,
      );
      return { ok: true, ignorado: true, motivo: `situação ${devolucao.situacao}` };
    }
    const tentativaAtual = devolucao.quantidadeTentativas + 1;

    // ── Pré-envio: nada disto toca a liquidante ───────────────────────────
    let credenciais: Record<string, unknown>;
    let liquidanteId: string;
    try {
      const conta = devolucao.transacao.contaProvedor;
      // Regra inegociável: provedor inativo/suspenso não movimenta nada.
      if (!conta || conta.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO) {
        throw new Error('Provedor inativo/ausente para a devolução');
      }
      const id = devolucao.transacao.tentativas[0]?.idTransacaoLiquidante;
      if (!id) {
        throw new Error('Transação sem identificador na liquidante');
      }
      liquidanteId = id;
      credenciais = decryptCredentials(conta.credenciaisCriptografadas);
    } catch (e) {
      return this.reterPreEnvio(devolucao.id, tentativaAtual, e);
    }

    const conta = devolucao.transacao.contaProvedor!;

    // ── Envio ─────────────────────────────────────────────────────────────
    let resultado: Awaited<
      ReturnType<ReturnType<ProviderRegistry['get']>['createRefund']>
    >;
    try {
      resultado = await this.providers.get(conta.provedor.codigo).createRefund({
        valor: money(devolucao.valor.toString()),
        idTransacaoLiquidante: liquidanteId,
        idTransacaoPrivado: devolucao.transacao.idTransacaoPrivado,
        idDevolucaoPublico: devolucao.idDevolucaoPublico,
        motivo: devolucao.motivo ?? undefined,
        credenciais,
      });
    } catch (e) {
      if (e instanceof ErroAntesDoEnvioError) {
        return this.reterPreEnvio(devolucao.id, tentativaAtual, e);
      }

      if (e instanceof RecusaAdquirenteError) {
        // A liquidante respondeu e disse NÃO — retry dá o mesmo não. O MED
        // continua aceito e o lojista debitado; devolver ao pagador virou
        // problema operacional: FALHA fica visível em /admin/dinheiro-parado.
        await this.prisma.devolucaoPix.updateMany({
          where: { id: devolucao.id, situacao: SITUACAO_DEVOLUCAO.PROCESSANDO },
          data: {
            situacao: SITUACAO_DEVOLUCAO.FALHA,
            ultimoErro: `RECUSADA: ${e.message}`.slice(0, 2000),
          },
        });
        this.logger.error(
          `OPS devolução ${devolucaoId} RECUSADA pela liquidante — pagador sem ` +
            `devolução, resolver manualmente: ${e.message.slice(0, 300)}`,
        );
        throw new UnrecoverableError(
          `Devolução ${devolucaoId} recusada pela liquidante: ${e.message.slice(0, 300)}`,
        );
      }

      // Timeout/5xx depois do POST: o refund PODE ter sido executado. Congela —
      // reenviar sem conferir na liquidante poderia devolver duas vezes.
      const detalhe = e instanceof Error ? e.message : String(e);
      await this.prisma.devolucaoPix.updateMany({
        where: { id: devolucao.id, situacao: SITUACAO_DEVOLUCAO.PROCESSANDO },
        data: {
          situacao: SITUACAO_DEVOLUCAO.AMBIGUA,
          ultimoErro: `AMBÍGUA — não reenviar sem conferir na liquidante: ${detalhe}`.slice(0, 2000),
        },
      });
      this.logger.error(
        `OPS devolução ${devolucaoId} com desfecho AMBÍGUO — congelada para ` +
          `conferência manual: ${detalhe.slice(0, 300)}`,
      );
      throw new UnrecoverableError(
        `Devolução ${devolucaoId} ambígua — conferir na liquidante antes de reenviar`,
      );
    }

    // ── Sucesso ───────────────────────────────────────────────────────────
    const outbox = await this.prisma.$transaction(async (tx) => {
      await tx.devolucaoPix.update({
        where: { id: devolucao.id },
        data: {
          situacao: SITUACAO_DEVOLUCAO.CONCLUIDA,
          identificadorDevolucaoProvedor:
            resultado.identificadorDevolucaoProvedor,
          ultimoErro: null,
        },
      });

      // Transação vira MED quando o total devolvido cobre o valor bruto.
      // O aggregate roda DEPOIS do update acima, então já inclui esta
      // devolução — somar devolucao.valor outra vez contaria em dobro e
      // marcaria MED com devolução apenas parcial.
      const concluido = await tx.devolucaoPix.aggregate({
        where: {
          transacaoId: devolucao.transacaoId,
          situacao: SITUACAO_DEVOLUCAO.CONCLUIDA,
        },
        _sum: { valor: true },
      });
      const somaAtual = money(concluido._sum.valor?.toString() ?? '0');
      if (somaAtual.gte(money(devolucao.transacao.valorBruto.toString()))) {
        await tx.transacao.update({
          where: { id: devolucao.transacaoId },
          data: { situacao: SITUACAO_TRANSACAO.MED },
        });
        await tx.historicoSituacaoTransacao.create({
          data: {
            transacaoId: devolucao.transacaoId,
            situacaoAnterior: devolucao.transacao.situacao,
            novaSituacao: SITUACAO_TRANSACAO.MED,
            origem: 'WORKER',
            motivo: 'Devolução MED concluída na liquidante',
          },
        });
      }

      // Callback ao lojista SEMPRE via outbox (claim atômico no publisher).
      return tx.eventoOutbox.create({
        data: {
          usuarioId: devolucao.transacao.usuarioId,
          tipoAgregado: 'DEVOLUCAO_PIX',
          identificadorAgregado: devolucao.transacao.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_DEVOLUCAO_CONCLUIDA,
          conteudo: {
            idTransacao: devolucao.transacao.idTransacaoPublico,
            idDevolucao: devolucao.idDevolucaoPublico,
            valor: devolucao.valor.toString(),
            motivo: devolucao.motivo,
          },
        },
      });
    });

    await this.queues.enqueueOutbox({
      eventoOutboxId: outbox.id.toString(),
      identificadorRastreio,
    });

    return { ok: true, devolucao: devolucao.idDevolucaoPublico };
  }

  /**
   * Falha ANTES de qualquer chamada externa: nada saiu, retry é seguro.
   * Abaixo do teto → volta a PENDENTE (BullMQ retenta; se esgotar, a varredura
   * da conciliação reenfileira). No teto → FALHA, sai da varredura e vira
   * decisão humana — o mesmo desenho do `LiberacaoSaldoProcessor`.
   */
  private async reterPreEnvio(
    devolucaoId: bigint,
    tentativaAtual: number,
    erro: unknown,
  ): Promise<never> {
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    const esgotou =
      tentativaAtual >= DevolucaoPixProcessor.MAXIMO_TENTATIVAS;

    await this.prisma.devolucaoPix.updateMany({
      where: { id: devolucaoId, situacao: SITUACAO_DEVOLUCAO.PROCESSANDO },
      data: {
        situacao: esgotou ? SITUACAO_DEVOLUCAO.FALHA : SITUACAO_DEVOLUCAO.PENDENTE,
        ultimoErro: (esgotou ? `TETO DE ${DevolucaoPixProcessor.MAXIMO_TENTATIVAS} TENTATIVAS: ` : '')
          .concat(detalhe)
          .slice(0, 2000),
      },
    });

    if (esgotou) {
      this.logger.error(
        `OPS devolução ${devolucaoId} atingiu o teto de tentativas — FALHA, ` +
          `resolver manualmente: ${detalhe.slice(0, 300)}`,
      );
      throw new UnrecoverableError(
        `Devolução ${devolucaoId} no teto de tentativas: ${detalhe.slice(0, 300)}`,
      );
    }

    this.logger.warn(
      `devolução ${devolucaoId} falhou no pré-envio (tentativa ${tentativaAtual}), ` +
        `volta a PENDENTE: ${detalhe.slice(0, 300)}`,
    );
    throw erro instanceof Error ? erro : new Error(detalhe);
  }
}
