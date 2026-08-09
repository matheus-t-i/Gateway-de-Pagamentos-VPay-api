import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueEvents } from 'bullmq';
import { QUEUE_NAMES } from '../shared';

/**
 * Escuta falhas terminais nas filas de dinheiro e emite log estruturado
 * `ALERTA_FILA` — base para pager/Datadog/CloudWatch a partir dos logs.
 */
@Injectable()
export class FilasAlertaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FilasAlertaService.name);
  private readonly events: QueueEvents[] = [];

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const criticas = [
      QUEUE_NAMES.PIX_WEBHOOK_RECEIVED,
      QUEUE_NAMES.PIX_WEBHOOK_RECEIVED_CASHOUT,
      QUEUE_NAMES.PIX_CASH_OUT,
      QUEUE_NAMES.CONCILIACAO,
      QUEUE_NAMES.DEVOLUCAO_PIX,
      QUEUE_NAMES.OUTBOX_PUBLISHER,
    ];
    for (const name of criticas) {
      const qe = new QueueEvents(name, { connection: { url } });
      qe.on('failed', ({ jobId, failedReason }) => {
        this.log.error(
          `ALERTA_FILA queue=${name} jobId=${jobId} reason=${String(failedReason).slice(0, 500)}`,
        );
      });
      this.events.push(qe);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.events.map((e) => e.close()));
  }
}
