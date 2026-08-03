import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DEFAULT_WEBHOOK_JOB_OPTIONS,
  DevolucaoPixJobPayload,
  EmailJobPayload,
  PixJobPayload,
  QUEUE_NAMES,
  SaqueAutomaticoJobPayload,
} from '../shared';

@Injectable()
export class QueuesService {
  constructor(
    @InjectQueue(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED)
    private readonly pixWebhookReceived: Queue,
    @InjectQueue(QUEUE_NAMES.PIX_WEBHOOK_SEND)
    private readonly pixWebhookSend: Queue,
    @InjectQueue(QUEUE_NAMES.PIX_WEBHOOK_RECEIVED_CASHOUT)
    private readonly pixWebhookCashout: Queue,
    @InjectQueue(QUEUE_NAMES.PIX_CASH_OUT)
    private readonly pixCashOut: Queue,
    @InjectQueue(QUEUE_NAMES.OUTBOX_PUBLISHER)
    private readonly outboxPublisher: Queue,
    @InjectQueue(QUEUE_NAMES.LIBERACAO_SALDO)
    private readonly liberacaoSaldo: Queue,
    @InjectQueue(QUEUE_NAMES.CONCILIACAO)
    private readonly conciliacao: Queue,
    @InjectQueue(QUEUE_NAMES.EMAILS)
    private readonly emails: Queue,
    @InjectQueue(QUEUE_NAMES.DEVOLUCAO_PIX)
    private readonly devolucaoPix: Queue,
    @InjectQueue(QUEUE_NAMES.SAQUE_AUTOMATICO)
    private readonly saqueAutomatico: Queue,
  ) {}

  enqueueSaqueAutomatico(data: SaqueAutomaticoJobPayload) {
    return this.saqueAutomatico.add('executar', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueueDevolucaoPix(data: DevolucaoPixJobPayload) {
    return this.devolucaoPix.add('process', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  /**
   * Enfileira e-mail transacional. Nunca lança para o chamador: falha de
   * notificação não pode derrubar cadastro, aprovação ou reset de senha.
   */
  async enqueueEmail(data: EmailJobPayload) {
    try {
      return await this.emails.add('enviar', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
    } catch {
      return null;
    }
  }

  enqueuePixWebhookReceived(data: PixJobPayload) {
    return this.pixWebhookReceived.add('process', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueuePixWebhookSend(data: PixJobPayload) {
    return this.pixWebhookSend.add('deliver', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueuePixWebhookCashout(data: PixJobPayload) {
    return this.pixWebhookCashout.add('process', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueuePixCashOut(data: PixJobPayload) {
    return this.pixCashOut.add('process', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueueOutbox(data: { eventoOutboxId: string; identificadorRastreio: string }) {
    return this.outboxPublisher.add('publish', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  async ensureRepeatables() {
    await this.liberacaoSaldo.add(
      'tick',
      { identificadorRastreio: 'scheduler' },
      {
        repeat: { every: 60_000 },
        jobId: 'liberacao-saldo-repeat',
        removeOnComplete: true,
      },
    );
    await this.conciliacao.add(
      'tick',
      { identificadorRastreio: 'scheduler' },
      {
        repeat: { every: 300_000 },
        jobId: 'conciliacao-repeat',
        removeOnComplete: true,
      },
    );
    await this.outboxPublisher.add(
      'tick',
      { eventoOutboxId: '', identificadorRastreio: 'scheduler' },
      {
        repeat: { every: 5_000 },
        jobId: 'outbox-publisher-repeat',
        removeOnComplete: true,
      },
    );
    // A frequência do tick não define a frequência do saque: cada gatilho tem
    // seu `intervaloMinimoMinutos`. O tick só olha saldo e reconcilia.
    await this.saqueAutomatico.add(
      'tick',
      { identificadorRastreio: 'scheduler' },
      {
        repeat: { every: 60_000 },
        jobId: 'saque-automatico-repeat',
        removeOnComplete: true,
      },
    );
  }
}
