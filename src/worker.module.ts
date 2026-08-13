import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { pinoHttpOptions } from './common/pino.config';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { QueuesModule } from './queues/queues.module';
import { ProvidersModule } from './providers/providers.module';
import { RetencaoModule } from './retencao/retencao.module';
import { QueuesService } from './queues/queues.service';
import { PixWebhookReceivedProcessor } from './worker-processors/pix-webhook-received.processor';
import { PixWebhookCashoutProcessor } from './worker-processors/pix-webhook-cashout.processor';
import { PixCashOutProcessor } from './worker-processors/pix-cash-out.processor';
import {
  ConciliacaoProcessor,
  LiberacaoSaldoProcessor,
  OutboxPublisherProcessor,
  PixWebhookSendProcessor,
  WebhookReenvioProcessor,
} from './worker-processors/outbox-and-ops.processors';
import { EntregaWebhookService } from './worker-processors/entrega-webhook.service';
import { IntegracaoEnvioProcessor } from './worker-processors/integracao-envio.processor';
import { IntegracoesService } from './integracoes/integracoes.service';
import { UtmifyClient } from './integracoes/utmify/utmify.client';
import { XtrackyClient } from './integracoes/xtracky/xtracky.client';
import { EmailProcessor } from './worker-processors/email.processor';
import { DevolucaoPixProcessor } from './worker-processors/devolucao-pix.processor';
import { SaqueAutomaticoProcessor } from './worker-processors/saque-automatico.processor';
import { EmailModule } from './email/email.module';
import { TesourariaModule } from './tesouraria/tesouraria.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: pinoHttpOptions(),
    }),
    PrismaModule,
    LedgerModule,
    QueuesModule.forWorker(),
    ProvidersModule,
    EmailModule,
    TesourariaModule,
    RetencaoModule,
  ],
  providers: [
    EntregaWebhookService,
    // Providers soltos em vez do `IntegracoesModule` inteiro: o worker não sobe
    // HTTP, então o controller do painel (e o AuthModule que ele arrasta) não
    // têm o que fazer aqui.
    UtmifyClient,
    XtrackyClient,
    IntegracoesService,
    IntegracaoEnvioProcessor,
    EmailProcessor,
    DevolucaoPixProcessor,
    SaqueAutomaticoProcessor,
    PixWebhookReceivedProcessor,
    PixWebhookCashoutProcessor,
    PixCashOutProcessor,
    PixWebhookSendProcessor,
    WebhookReenvioProcessor,
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
