import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { QueuesModule } from './queues/queues.module';
import { ProvidersModule } from './providers/providers.module';
import { QueuesService } from './queues/queues.service';
import { PixWebhookReceivedProcessor } from './worker-processors/pix-webhook-received.processor';
import { PixWebhookCashoutProcessor } from './worker-processors/pix-webhook-cashout.processor';
import { PixCashOutProcessor } from './worker-processors/pix-cash-out.processor';
import {
  ConciliacaoProcessor,
  LiberacaoSaldoProcessor,
  OutboxPublisherProcessor,
  PixWebhookSendProcessor,
} from './worker-processors/outbox-and-ops.processors';
import { EmailProcessor } from './worker-processors/email.processor';
import { DevolucaoPixProcessor } from './worker-processors/devolucao-pix.processor';
import { SaqueAutomaticoProcessor } from './worker-processors/saque-automatico.processor';
import { EmailModule } from './email/email.module';
import { TesourariaModule } from './tesouraria/tesouraria.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    PrismaModule,
    LedgerModule,
    QueuesModule.forWorker(),
    ProvidersModule,
    EmailModule,
    TesourariaModule,
  ],
  providers: [
    EmailProcessor,
    DevolucaoPixProcessor,
    SaqueAutomaticoProcessor,
    PixWebhookReceivedProcessor,
    PixWebhookCashoutProcessor,
    PixCashOutProcessor,
    PixWebhookSendProcessor,
    OutboxPublisherProcessor,
    LiberacaoSaldoProcessor,
    ConciliacaoProcessor,
  ],
})
export class WorkerModule implements OnModuleInit {
  constructor(private readonly queues: QueuesService) {}

  async onModuleInit() {
    await this.queues.ensureRepeatables();
  }
}
