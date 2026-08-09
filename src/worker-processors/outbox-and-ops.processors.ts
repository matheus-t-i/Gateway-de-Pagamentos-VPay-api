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
  SITUACAO_TENTATIVA,
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
import { CashInCreditoService } from '../retencao/cashin-credito.service';
import {
  assertValorCamada1Compativel,
  extrairValorDePayload,
} from '../providers/valor-remoto.util';

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

    /**
     * Claim atômico: só publica quem conseguiu marcar publicadoRedisEm (0 -> 1).
     * Sem isto, o job periódico e o enfileiramento direto processam o mesmo
     * evento em paralelo e o lojista recebe o callback várias vezes.
     *
     * A reserva dos envios aos apps conectados entra na MESMA transação. O
     * claim é irreversível: um worker que morra entre reivindicar o evento e
     * reservar o envio faria a venda nunca chegar ao app, e o evento nunca mais
     * seria reprocessado — perda silenciosa, confirmada em teste. Com os dois no
     * mesmo commit, ou nada aconteceu (e o próximo tick refaz), ou a linha
     * PENDENTE existe e a varredura de presos garante a entrega.
     */
    const pending: Array<{ ev: (typeof candidatos)[number]; enviosApps: bigint[] }> = [];
    for (const ev of candidatos) {
      const reservados = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.eventoOutbox.updateMany({
          where: { id: ev.id, publicadoRedisEm: null },
          data: { publicadoRedisEm: new Date() },
        });
        if (claim.count !== 1) return null;

        const evento = OutboxPublisherProcessor.EVENTO_INTEGRACAO[ev.tipoEvento];
        if (!evento || !ev.usuarioId) return [];

        const venda = await tx.transacao.findFirst({
          where: {
            idTransacaoPublico: ev.identificadorAgregado,
            usuarioId: ev.usuarioId,
          },
          select: { id: true },
        });
        if (!venda) return [];

        return this.integracoes.reservarEnviosDoEvento(tx, {
          transacaoId: venda.id,
          usuarioId: ev.usuarioId,
          evento,
        });
      });

      if (reservados !== null) pending.push({ ev, enviosApps: reservados });
    }

    for (const { ev, enviosApps } of pending) {
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
        // Falhou ao enfileirar: devolve o claim para nova tentativa. Os envios
        // já reservados NÃO são desfeitos — a unique os torna idempotentes, e a
        // varredura de presos entrega o que ficar para trás.
        await this.prisma.eventoOutbox.update({
          where: { id: ev.id },
          data: {
            publicadoRedisEm: null,
            quantidadeTentativasPublicacao: { increment: 1 },
            ultimoErroPublicacao: e instanceof Error ? e.message : String(e),
          },
        });
        continue;
      }

      /**
       * Mesmo fan-out, segundo destino: os apps que o lojista conectou.
       *
       * FORA do try acima de propósito — devolver o claim por causa de uma
       * integração faria o lojista receber o callback duas vezes. Aqui só resta
       * enfileirar: a linha de envio já foi criada junto com o claim, então
       * mesmo que este processo morra agora, nada se perde.
       */
      await this.integracoes.enfileirarEnvios(enviosApps);
    }

    /**
     * Rede de segurança: envios que nunca chegaram à fila (worker morto, Redis
     * fora do ar no `enqueue`). Só no tick periódico — no job de um evento
     * específico varrer a tabela inteira seria trabalho fora de escopo.
     */
    if (!job.data.eventoOutboxId) {
      await this.integracoes.reenfileirarPendentes();
    }

    return { published: pending.length };
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
    private readonly credito: CashInCreditoService,
    private readonly ledger: LedgerService,
    private readonly queues: QueuesService,
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
            // Cash-in fantasma pós-TIMEOUT: venda foi a FALHA local mas a
            // cobrança pode ter sido aceita/paga na liquidante.
            SITUACAO_TRANSACAO.FALHA,
          ],
        },
        criadoEm: { lte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      take: 40,
      include: {
        contaProvedor: { include: { provedor: true } },
        tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 3 },
      },
    });
    this.logger.log(`conciliação pendentes=${pendentes.length}`);

    let liquidados = 0;
    for (const tx of pendentes) {
      // FALHA só interessa no cash-in (fantasma); cash-out FALHA já encerrou.
      if (
        tx.situacao === SITUACAO_TRANSACAO.FALHA &&
        tx.direcao !== 'ENTRADA'
      ) {
        continue;
      }

      if (
        !tx.contaProvedor ||
        tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
      )
        continue;

      const tentativaComId = tx.tentativas.find((t) => t.idTransacaoLiquidante);
      const tentativa = tentativaComId ?? tx.tentativas[0];
      const liquidanteId = tentativaComId?.idTransacaoLiquidante;
      if (!liquidanteId) {
        // Saque ENVIANDO sem id = crash pós-aceite sem eco de ref ainda.
        if (
          tx.direcao === 'SAIDA' &&
          tentativa?.situacao === SITUACAO_TENTATIVA.ENVIANDO
        ) {
          this.logger.error(
            `OPS conciliação: saque tx=${tx.idTransacaoPublico} ENVIANDO sem ` +
              'idTransacaoLiquidante — conferir na liquidante manualmente',
          );
        }
        // Cash-in FALHA/TIMEOUT sem id: cobrança fantasma possível — só OPS
        // (sem id não há getStatus; recovery vem pelo webhook + externaRef).
        if (
          tx.direcao === 'ENTRADA' &&
          tx.situacao === SITUACAO_TRANSACAO.FALHA &&
          (tentativa?.mensagemErro ?? '').toUpperCase().includes('TIMEOUT')
        ) {
          this.logger.error(
            `OPS conciliação: cash-in fantasma suspeito tx=${tx.idTransacaoPublico} ` +
              `privado=${tx.idTransacaoPrivado} — conferir na liquidante por externaRef`,
          );
        }
        continue;
      }

      let credenciais: Record<string, unknown>;
      try {
        credenciais = decryptCredentials(tx.contaProvedor.credenciaisCriptografadas);
      } catch {
        credenciais = JSON.parse(tx.contaProvedor.credenciaisCriptografadas);
      }

      try {
        const status = await this.providers
          .get(tx.contaProvedor.provedor.codigo)
          .getStatus({
            idTransacaoLiquidante: liquidanteId,
            idTransacaoPrivado: tx.idTransacaoPrivado,
            credenciais,
          });

        if (tx.direcao === 'ENTRADA') {
          const creditavel =
            (
              [
                SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
                SITUACAO_TRANSACAO.FALHA,
              ] as string[]
            ).includes(tx.situacao) &&
            ['PAID', 'COMPLETED'].includes(status.status) &&
            !tx.retidaMetodo;
          if (creditavel) {
            const valorRemoto =
              status.valor ?? extrairValorDePayload(status.raw);
            assertValorCamada1Compativel(
              money(tx.valorBruto.toString()),
              valorRemoto,
            );
            await this.credito.creditar({
              transacaoId: tx.id,
              endToEndId: status.endToEndId,
              liquidadoEm: status.paidAt ?? new Date(),
              origem: 'CONCILIACAO',
              motivo: `Conciliação: liquidante confirmou ${status.status}`,
              identificadorRastreio: `conciliacao:${tx.id}`,
            });
            liquidados += 1;
            this.logger.log(
              `conciliação creditou cash-in tx=${tx.idTransacaoPublico}` +
                (tx.situacao === SITUACAO_TRANSACAO.FALHA
                  ? ' (recuperação pós-FALHA/fantasma)'
                  : ''),
            );
          }
          continue;
        }

        // Cash-out
        if (tx.situacao !== SITUACAO_TRANSACAO.PROCESSANDO) continue;

        if (['PAID', 'COMPLETED'].includes(status.status)) {
          const n = await this.prisma.transacao.updateMany({
            where: {
              id: tx.id,
              situacao: SITUACAO_TRANSACAO.PROCESSANDO,
            },
            data: {
              situacao: SITUACAO_TRANSACAO.CONCLUIDA,
              liquidadoEm: status.paidAt ?? new Date(),
              concluidoEm: new Date(),
            },
          });
          if (n.count === 0) continue;
          await this.prisma.$transaction([
            // A resposta do banco que DECIDIU o desfecho fica salva na tentativa
            // — sem isto, um saque resolvido pela conciliação (webhook perdido)
            // ficaria CONCLUIDA/FALHA sem nenhum registro do que a liquidante
            // devolveu, e o admin não teria o que repassar ao cliente.
            this.prisma.tentativaTransacao.update({
              where: { id: tentativa.id },
              data: { dadosResposta: (status.raw ?? undefined) as object },
            }),
            this.prisma.historicoSituacaoTransacao.create({
              data: {
                transacaoId: tx.id,
                situacaoAnterior: SITUACAO_TRANSACAO.PROCESSANDO,
                novaSituacao: SITUACAO_TRANSACAO.CONCLUIDA,
                origem: 'CONCILIACAO',
                motivo: `Conciliação: liquidante confirmou ${status.status}`,
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
          ]);
          liquidados += 1;
          this.logger.log(
            `conciliação fechou cash-out CONCLUIDA tx=${tx.idTransacaoPublico}`,
          );
        } else if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(status.status)) {
          /**
           * Estorno + FALHA + histórico + outbox no MESMO commit — ver a
           * mesma correção em `encerrarComoFalha` do webhook de cash-out.
           * Se o estorno falhar (deadlock/blip), tudo reverte, a tx segue
           * PROCESSANDO e o próximo tick da conciliação refaz. Antes, o FALHA
           * commitava sozinho e um erro no estorno deixava dinheiro preso — e
           * a conciliação só revisita PROCESSANDO, então nunca mais voltava.
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
              descricao: `Estorno conciliação — ${status.status}`.slice(0, 500),
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
              descricao: 'Estorno da tarifa de saque (conciliação)',
            });
          }

          const estornado = await this.prisma.$transaction(async (db) => {
            const n = await db.transacao.updateMany({
              where: { id: tx.id, situacao: SITUACAO_TRANSACAO.PROCESSANDO },
              data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
            });
            if (n.count === 0) return false;

            // Resposta do banco que decidiu a FALHA — salva no mesmo commit.
            await db.tentativaTransacao.update({
              where: { id: tentativa.id },
              data: { dadosResposta: (status.raw ?? undefined) as object },
            });

            await this.ledger.aplicarMovimentacoes(
              { usuarioId: tx.usuarioId, entries },
              db,
            );

            await db.historicoSituacaoTransacao.create({
              data: {
                transacaoId: tx.id,
                situacaoAnterior: SITUACAO_TRANSACAO.PROCESSANDO,
                novaSituacao: SITUACAO_TRANSACAO.FALHA,
                origem: 'CONCILIACAO',
                motivo: `Conciliação: liquidante confirmou ${status.status}`,
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
                  motivo: `Conciliação: ${status.status}`,
                },
              },
            });
            return true;
          });
          if (!estornado) continue;
          liquidados += 1;
          this.logger.log(
            `conciliação fechou cash-out FALHA+estorno tx=${tx.idTransacaoPublico}`,
          );
        } else {
          this.logger.debug(
            `tx ${tx.idTransacaoPublico} remote=${status.status}`,
          );
        }
      } catch (e) {
        this.logger.warn(`falha conciliação ${tx.id}: ${e}`);
      }
    }

    // Recovery: saques PROCESSANDO sem tentativa ativa e sem job na fila.
    const orfaos = await this.prisma.transacao.findMany({
      where: {
        direcao: 'SAIDA',
        situacao: SITUACAO_TRANSACAO.PROCESSANDO,
        criadoEm: { lte: new Date(Date.now() - 2 * 60 * 1000) },
        tentativas: {
          none: { situacao: { not: SITUACAO_TENTATIVA.FALHA } },
        },
      },
      take: 20,
      include: { contaProvedor: { include: { provedor: true } } },
    });
    for (const tx of orfaos) {
      if (!tx.contaProvedor) continue;
      try {
        await this.queues.enqueuePixCashOut({
          provider: tx.contaProvedor.provedor.codigo,
          contaProvedorId: tx.contaProvedorId?.toString(),
          payload: {
            transacaoId: tx.id.toString(),
            idTransacaoPrivado: tx.idTransacaoPrivado,
          },
          identificadorRastreio: `conciliacao-reenfileira:${tx.id}`,
        });
        this.logger.warn(
          `conciliação reenfileirou saque órfão tx=${tx.idTransacaoPublico}`,
        );
      } catch (e) {
        this.logger.warn(`falha ao reenfileirar saque ${tx.id}: ${e}`);
      }
    }

    return { checked: pendentes.length, liquidados, orfaosReenfileirados: orfaos.length };
  }
}
