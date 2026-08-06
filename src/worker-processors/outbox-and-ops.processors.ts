import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  EVENTOS_INTEGRACAO,
  EVENTOS_LOJISTA,
  EventoIntegracao,
  LiberacaoSaldoJobPayload,
  OutboxPublishJobPayload,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_LIBERACAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
  WebhookReenvioJobPayload,
  money,
} from '../shared';
import { IntegracoesService } from '../integracoes/integracoes.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { BloqueiosSaldoService } from '../ledger/bloqueios-saldo.service';
import { QueuesService } from '../queues/queues.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';
import { EntregaWebhookService } from './entrega-webhook.service';

@Processor(QUEUE_NAMES.PIX_WEBHOOK_SEND)
@Injectable()
export class PixWebhookSendProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookSendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entregas: EntregaWebhookService,
  ) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const payload = job.data.payload as {
      tipoEvento: string;
      idPublico: string;
      usuarioId: string;
      eventoOutboxId?: string;
      conteudo?: unknown;
    };
    this.logger.log(`entregando webhook lojista evento=${payload.tipoEvento}`);

    const usuarioId = BigInt(payload.usuarioId);

    let eventoOutboxId = payload.eventoOutboxId
      ? BigInt(payload.eventoOutboxId)
      : undefined;

    if (!eventoOutboxId) {
      const outbox = await this.prisma.eventoOutbox.findFirst({
        where: {
          usuarioId,
          identificadorAgregado: payload.idPublico,
          tipoEvento: payload.tipoEvento,
        },
        orderBy: { id: 'desc' },
      });
      eventoOutboxId = outbox?.id;
    }
    if (!eventoOutboxId) return { ok: true, entregas: 0, motivo: 'sem evento outbox' };

    const { entregas } = await this.entregas.entregarTodos({
      usuarioId,
      eventoOutboxId,
      idTransacaoPublico: payload.idPublico,
      tipoEvento: payload.tipoEvento,
    });

    return { ok: true, entregas };
  }
}

/**
 * Reenvio MANUAL do callback (botão do painel/admin), em fila própria para não
 * concorrer com a entrega automática nem distorcer o backlog dela.
 *
 * Não recria evento nem toca no claim do outbox: o evento já existe e foi
 * publicado — o que se repete aqui é só a ENTREGA HTTP, registrada em
 * `entregas_webhook` como mais uma tentativa. Assim o lojista pode receber de
 * novo sem que nada seja creditado/movimentado outra vez.
 */
@Processor(QUEUE_NAMES.WEBHOOK_REENVIO)
@Injectable()
export class WebhookReenvioProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookReenvioProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entregas: EntregaWebhookService,
  ) {
    super();
  }

  async process(job: Job<WebhookReenvioJobPayload>) {
    const { eventoOutboxId, idTransacaoPublico, solicitadoPorUsuarioId } = job.data;
    this.logger.log(
      `reenvio manual de callback tx=${idTransacaoPublico} ` +
        `evento=${eventoOutboxId} por=${solicitadoPorUsuarioId ?? '—'}`,
    );

    const evento = await this.prisma.eventoOutbox.findUnique({
      where: { id: BigInt(eventoOutboxId) },
    });
    if (!evento) return { ok: false, motivo: 'evento outbox inexistente' };
    if (!evento.usuarioId) return { ok: false, motivo: 'evento sem usuário' };

    const { entregas } = await this.entregas.entregarTodos({
      usuarioId: evento.usuarioId,
      eventoOutboxId: evento.id,
      idTransacaoPublico: evento.identificadorAgregado,
      tipoEvento: evento.tipoEvento,
    });

    return { ok: true, entregas };
  }
}

@Processor(QUEUE_NAMES.OUTBOX_PUBLISHER)
@Injectable()
export class OutboxPublisherProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxPublisherProcessor.name);

  /**
   * Evento do outbox → evento das integrações. Só o que interessa a app de
   * rastreio de venda; o resto passa direto.
   */
  private static readonly EVENTO_INTEGRACAO: Record<string, EventoIntegracao> = {
    [EVENTOS_LOJISTA.PIX_CASHIN_PAGO]: EVENTOS_INTEGRACAO.PEDIDO_PAGO,
    [EVENTOS_LOJISTA.PIX_DEVOLUCAO_CONCLUIDA]: EVENTOS_INTEGRACAO.PEDIDO_DEVOLVIDO,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly integracoes: IntegracoesService,
  ) {
    super();
  }

  async process(job: Job<OutboxPublishJobPayload>) {
    const candidatos = job.data.eventoOutboxId
      ? await this.prisma.eventoOutbox.findMany({
          where: { id: BigInt(job.data.eventoOutboxId), publicadoRedisEm: null },
        })
      : await this.prisma.eventoOutbox.findMany({
          where: { publicadoRedisEm: null },
          take: 50,
          orderBy: { id: 'asc' },
        });

    // Claim atômico: só publica quem conseguiu marcar publicadoRedisEm (0 -> 1).
    // Sem isto, o job periódico e o enfileiramento direto processam o mesmo
    // evento em paralelo e o lojista recebe o callback várias vezes.
    const pending = [];
    for (const ev of candidatos) {
      const claim = await this.prisma.eventoOutbox.updateMany({
        where: { id: ev.id, publicadoRedisEm: null },
        data: { publicadoRedisEm: new Date() },
      });
      if (claim.count === 1) pending.push(ev);
    }

    for (const ev of pending) {
      try {
        await this.queues.enqueuePixWebhookSend({
          provider: 'system',
          payload: {
            tipoEvento: ev.tipoEvento,
            idPublico: ev.identificadorAgregado,
            usuarioId: ev.usuarioId?.toString() ?? '',
            eventoOutboxId: ev.id.toString(),
            conteudo: ev.conteudo,
          },
          identificadorRastreio: job.data.identificadorRastreio,
        });
      } catch (e) {
        this.logger.error(e);
        // Falhou ao enfileirar: devolve o claim para nova tentativa.
        await this.prisma.eventoOutbox.update({
          where: { id: ev.id },
          data: {
            publicadoRedisEm: null,
            quantidadeTentativasPublicacao: { increment: 1 },
            ultimoErroPublicacao: e instanceof Error ? e.message : String(e),
          },
        });
        // Sem callback publicado, não há o que contar aos apps ainda.
        continue;
      }

      /**
       * Mesmo fan-out, segundo destino: os apps que o lojista conectou.
       *
       * Depois do enfileiramento do callback e FORA do try acima de propósito —
       * devolver o claim por causa de uma integração faria o lojista receber o
       * callback duas vezes. O envio ao app tem dedupe próprio
       * (`envios_integracao`) e reenvio pela tela.
       */
      await this.notificarIntegracoes(ev);
    }
    return { published: pending.length };
  }

  private async notificarIntegracoes(ev: {
    tipoEvento: string;
    identificadorAgregado: string;
    usuarioId: bigint | null;
  }) {
    const evento = OutboxPublisherProcessor.EVENTO_INTEGRACAO[ev.tipoEvento];
    if (!evento || !ev.usuarioId) return;

    // O outbox guarda o id PÚBLICO da transação; o resto do fluxo trabalha com
    // o id interno. Filtrar também por usuário mantém a mesma regra do callback.
    const tx = await this.prisma.transacao.findFirst({
      where: {
        idTransacaoPublico: ev.identificadorAgregado,
        usuarioId: ev.usuarioId,
      },
      select: { id: true },
    });
    if (!tx) return;

    await this.integracoes.notificarSemFalhar(tx.id, evento);
  }
}

@Processor(QUEUE_NAMES.LIBERACAO_SALDO)
@Injectable()
export class LiberacaoSaldoProcessor extends WorkerHost {
  private readonly logger = new Logger(LiberacaoSaldoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly bloqueios: BloqueiosSaldoService,
  ) {
    super();
  }

  /**
   * Teto de retentativas de uma liberação. Chegou aqui, o problema não é
   * transitório e precisa de gente olhando (a linha fica em FALHA e aparece no
   * alerta de `/admin/carteiras`).
   */
  private static readonly MAXIMO_TENTATIVAS = 8;
  /** Espaçamento entre retentativas da MESMA liberação. */
  private static readonly ESPERA_RETENTATIVA_MS = 10 * 60 * 1000;

  async process(_job: Job<LiberacaoSaldoJobPayload>) {
    const agora = new Date();
    const desde = new Date(
      agora.getTime() - LiberacaoSaldoProcessor.ESPERA_RETENTATIVA_MS,
    );
    /**
     * Além das AGENDADA vencidas, este passe recolhe o que ficou para trás:
     *
     * - `FALHA`: erro transitório (banco fora, deadlock, conta que estava
     *   negativa). Era TERMINAL — nada no sistema reprocessava, então uma falha
     *   de um minuto congelava o dinheiro do lojista em `PENDENTE_LIBERACAO`
     *   para sempre, e só um UPDATE no banco destravava.
     * - `PROCESSANDO`: o worker morreu entre marcar e mover o saldo.
     *
     * Reprocessar é seguro porque as duas entries têm chave de idempotência
     * fixa (`lib:deb:<id>` / `lib:cred:<id>`): a segunda passada encontra as
     * movimentações já criadas e não credita de novo.
     */
    const due = await this.prisma.liberacaoSaldo.findMany({
      where: {
        liberarEm: { lte: agora },
        OR: [
          { situacao: SITUACAO_LIBERACAO.AGENDADA },
          {
            situacao: {
              in: [SITUACAO_LIBERACAO.FALHA, SITUACAO_LIBERACAO.PROCESSANDO],
            },
            quantidadeTentativas: { lt: LiberacaoSaldoProcessor.MAXIMO_TENTATIVAS },
            atualizadoEm: { lte: desde },
          },
        ],
      },
      orderBy: { liberarEm: 'asc' },
      take: 50,
    });
    const retentativas = due.filter(
      (l) => l.situacao !== SITUACAO_LIBERACAO.AGENDADA,
    ).length;
    this.logger.log(
      `liberacoes vencidas: ${due.length} (retentativas: ${retentativas})`,
    );

    for (const lib of due) {
      // Claim atômico (mesmo padrão do outbox): dois ticks sobrepostos não
      // duplicam dinheiro (as chaves de idempotência barram), mas queimariam o
      // teto de tentativas em dobro e um passe reprocessaria o que o outro já
      // está mexendo.
      const claim = await this.prisma.liberacaoSaldo.updateMany({
        where: { id: lib.id, situacao: lib.situacao },
        data: {
          situacao: SITUACAO_LIBERACAO.PROCESSANDO,
          quantidadeTentativas: { increment: 1 },
        },
      });
      if (claim.count !== 1) continue;
      try {
        const from =
          lib.tipoLiberacao === 'RESERVA' ? 'RESERVADO' : 'PENDENTE_LIBERACAO';
        const result = await this.ledger.aplicarMovimentacoes({
          usuarioId: lib.usuarioId,
          entries: [
            {
              tipoSaldo: from,
              tipoMovimento: 'DEBITO',
              natureza: 'LIBERACAO',
              valor: money(lib.valor.toString()),
              chaveIdempotencia: `lib:deb:${lib.id}`,
              transacaoId: lib.transacaoId,
              descricao: `Liberação ${lib.tipoLiberacao}`,
            },
            {
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'CREDITO',
              natureza: 'LIBERACAO',
              valor: money(lib.valor.toString()),
              chaveIdempotencia: `lib:cred:${lib.id}`,
              transacaoId: lib.transacaoId,
              descricao: `Liberação ${lib.tipoLiberacao} → disponível`,
            },
          ],
        });
        await this.prisma.liberacaoSaldo.update({
          where: { id: lib.id },
          data: {
            situacao: SITUACAO_LIBERACAO.LIBERADA,
            processadoEm: new Date(),
            movimentacaoLiberacaoId: result.movimentacoes[1]?.id,
          },
        });
        // Bloqueio administrativo ativo captura o que acabou de virar disponível.
        await this.bloqueios.capturarSemFalhar(lib.usuarioId, `lib:${lib.id}`);
      } catch (e) {
        const tentativas = lib.quantidadeTentativas + 1;
        const esgotou = tentativas >= LiberacaoSaldoProcessor.MAXIMO_TENTATIVAS;
        await this.prisma.liberacaoSaldo.update({
          where: { id: lib.id },
          data: {
            situacao: SITUACAO_LIBERACAO.FALHA,
            ultimoErro: e instanceof Error ? e.message : String(e),
          },
        });
        // Esgotar o teto é dinheiro do lojista parado sem ninguém saber: sobe
        // como erro no log e a linha entra no alerta de liberações travadas.
        const msg = `liberacao ${lib.id} (usuario ${lib.usuarioId}) falhou na tentativa ${tentativas}: ${
          e instanceof Error ? e.message : String(e)
        }`;
        if (esgotou) this.logger.error(`${msg} — TETO DE TENTATIVAS ATINGIDO`);
        else this.logger.warn(msg);
      }
    }
    return { processed: due.length };
  }
}

@Processor(QUEUE_NAMES.CONCILIACAO)
@Injectable()
export class ConciliacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(ConciliacaoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {
    super();
  }

  async process() {
    const pendentes = await this.prisma.transacao.findMany({
      where: {
        situacao: {
          in: [
            SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
            SITUACAO_TRANSACAO.PROCESSANDO,
          ],
        },
        criadoEm: { lte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      take: 30,
      include: {
        contaProvedor: { include: { provedor: true } },
        tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 1 },
      },
    });
    this.logger.log(`conciliação pendentes=${pendentes.length}`);

    for (const tx of pendentes) {
      if (
        !tx.contaProvedor ||
        tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
      )
        continue;
      const liquidanteId = tx.tentativas[0]?.idTransacaoLiquidante;
      if (!liquidanteId) continue;
      let credenciais: Record<string, unknown>;
      try {
        credenciais = decryptCredentials(tx.contaProvedor.credenciaisCriptografadas);
      } catch {
        credenciais = JSON.parse(tx.contaProvedor.credenciaisCriptografadas);
      }
      try {
        const status = await this.providers.get(tx.contaProvedor.provedor.codigo).getStatus({
          idTransacaoLiquidante: liquidanteId,
          idTransacaoPrivado: tx.idTransacaoPrivado,
          credenciais,
        });
        this.logger.debug(
          `tx ${tx.idTransacaoPublico} remote=${status.status}`,
        );
      } catch (e) {
        this.logger.warn(`falha conciliação ${tx.id}: ${e}`);
      }
    }
    return { checked: pendentes.length };
  }
}
