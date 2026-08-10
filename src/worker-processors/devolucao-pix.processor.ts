import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
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
import { ProviderRegistry } from '../providers/provider.registry';
import { QueuesService } from '../queues/queues.service';
import { decryptCredentials } from '../common/crypto.util';

/**
 * Efetiva a devolução PIX (MED aceito) na liquidante.
 *
 * O ledger já foi liquidado na decisão do caso — este passo é a transferência
 * externa. Roda em fila com retentativas: liquidante fora do ar não pode
 * perder a devolução, e a operação é idempotente (provider recebe o
 * idDevolucaoPublico como chave).
 */
@Processor(QUEUE_NAMES.DEVOLUCAO_PIX)
@Injectable()
export class DevolucaoPixProcessor extends WorkerHost {
  private readonly logger = new Logger(DevolucaoPixProcessor.name);

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
    if (!devolucao) throw new Error(`Devolução ${devolucaoId} não encontrada`);

    // Idempotência: retentativa depois de sucesso não reenviar nada.
    if (devolucao.situacao === SITUACAO_DEVOLUCAO.CONCLUIDA) {
      return { ok: true, jaConcluida: true };
    }

    const conta = devolucao.transacao.contaProvedor;
    // Regra inegociável: provedor inativo/suspenso não movimenta nada.
    if (!conta || conta.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO) {
      throw new Error('Provedor inativo/ausente para a devolução');
    }
    const liquidanteId = devolucao.transacao.tentativas[0]?.idTransacaoLiquidante;
    if (!liquidanteId) {
      throw new Error('Transação sem identificador na liquidante');
    }

    await this.prisma.devolucaoPix.update({
      where: { id: devolucao.id },
      data: { situacao: SITUACAO_DEVOLUCAO.PROCESSANDO },
    });

    let credenciais: Record<string, unknown>;
    credenciais = decryptCredentials(conta.credenciaisCriptografadas);

    try {
      const resultado = await this.providers.get(conta.provedor.codigo).createRefund({
        valor: money(devolucao.valor.toString()),
        idTransacaoLiquidante: liquidanteId,
        idTransacaoPrivado: devolucao.transacao.idTransacaoPrivado,
        idDevolucaoPublico: devolucao.idDevolucaoPublico,
        motivo: devolucao.motivo ?? undefined,
        credenciais,
      });

      const outbox = await this.prisma.$transaction(async (tx) => {
        await tx.devolucaoPix.update({
          where: { id: devolucao.id },
          data: {
            situacao: SITUACAO_DEVOLUCAO.CONCLUIDA,
            identificadorDevolucaoProvedor:
              resultado.identificadorDevolucaoProvedor,
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
    } catch (e) {
      // FALHA fica visível na fila/painel; a retentativa do BullMQ reprocessa.
      await this.prisma.devolucaoPix.update({
        where: { id: devolucao.id },
        data: { situacao: SITUACAO_DEVOLUCAO.FALHA },
      });
      throw e;
    }
  }
}
