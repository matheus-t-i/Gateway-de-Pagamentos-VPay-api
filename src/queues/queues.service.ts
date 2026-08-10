import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DEFAULT_WEBHOOK_JOB_OPTIONS,
  DevolucaoPixJobPayload,
  EmailJobPayload,
  IntegracaoEnvioJobPayload,
  PixJobPayload,
  QUEUE_NAMES,
  SaqueAutomaticoJobPayload,
  WebhookReenvioJobPayload,
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
    @InjectQueue(QUEUE_NAMES.WEBHOOK_REENVIO)
    private readonly webhookReenvio: Queue,
    @InjectQueue(QUEUE_NAMES.INTEGRACAO_ENVIO)
    private readonly integracaoEnvio: Queue,
  ) {}

  /**
   * Envio para um app conectado pelo lojista. Nunca lança: app de terceiro fora
   * do ar (ou Redis instável) não pode derrubar a criação da venda nem a
   * publicação do outbox, que são o caminho do dinheiro. O envio fica gravado
   * como PENDENTE e o lojista reenvia pela tela.
   */
  async enqueueIntegracaoEnvio(data: IntegracaoEnvioJobPayload) {
    try {
      return await this.integracaoEnvio.add(
        'enviar',
        data,
        DEFAULT_WEBHOOK_JOB_OPTIONS,
      );
    } catch {
      return null;
    }
  }

  /**
   * Reenvio manual do callback ao lojista. Fila própria — não vai para a
   * `2-pix-webhook-send` justamente para o reprocessamento sob demanda não se
   * misturar ao fluxo automático.
   */
  enqueueWebhookReenvio(data: WebhookReenvioJobPayload) {
    return this.webhookReenvio.add('reenviar', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

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

  // ⚠️ jobId customizado NÃO pode conter ':' — o BullMQ 5 valida e o `add`
  // LANÇA ("Custom Id cannot contain :"). Com `saque:<id>` o enqueue do
  // próprio saque falhava DEPOIS do débito (saldo debitado, nenhum job) e o
  // webhook de cash-in nem entrava na fila. Encontrado no smoke da imagem
  // Docker — separador é '-' daqui em diante.
  enqueuePixWebhookReceived(data: PixJobPayload) {
    const webhookId = data.webhookRecebidoId;
    return this.addComJobIdEstavel(
      this.pixWebhookReceived,
      'process',
      data,
      webhookId ? `webhook-in-${webhookId}` : undefined,
    );
  }

  enqueuePixWebhookSend(data: PixJobPayload) {
    return this.pixWebhookSend.add('deliver', data, DEFAULT_WEBHOOK_JOB_OPTIONS);
  }

  enqueuePixWebhookCashout(data: PixJobPayload) {
    const webhookId = data.webhookRecebidoId;
    return this.addComJobIdEstavel(
      this.pixWebhookCashout,
      'process',
      data,
      webhookId ? `webhook-out-${webhookId}` : undefined,
    );
  }

  /**
   * Um job por saque. Dois enqueues da mesma `transacaoId` (replay após falha
   * de Redis, retry do cliente) colapsam no mesmo jobId — sem fila duplicada
   * alimentando dois workers.
   */
  enqueuePixCashOut(data: PixJobPayload) {
    const payload = data.payload as { transacaoId?: string } | undefined;
    const txId = payload?.transacaoId;
    return this.addComJobIdEstavel(
      this.pixCashOut,
      'process',
      data,
      txId ? `saque-${txId}` : undefined,
    );
  }

  /**
   * Enfileira com `jobId` estável. Se o job anterior falhou ou já completou e
   * ainda está no Redis, remove e recria — senão o dedupe do BullMQ engoliria
   * o reenfileiramento (webhook gravado sem job, saque debitado sem fila).
   */
  private async addComJobIdEstavel(
    queue: Queue,
    name: string,
    data: unknown,
    jobId: string | undefined,
  ) {
    if (!jobId) {
      return queue.add(name, data, DEFAULT_WEBHOOK_JOB_OPTIONS);
    }
    const existente = await queue.getJob(jobId);
    if (existente) {
      const state = await existente.getState();
      if (state === 'completed' || state === 'failed') {
        await existente.remove();
      } else {
        // waiting / active / delayed — já há quem cuide.
        return existente;
      }
    }
    return queue.add(name, data, {
      ...DEFAULT_WEBHOOK_JOB_OPTIONS,
      jobId,
    });
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
