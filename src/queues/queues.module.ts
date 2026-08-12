import { DynamicModule, Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ALL_QUEUE_NAMES, nomeExibicaoFila, QUEUE_NAMES } from '../shared';
import { AuthModule } from '../auth/auth.module';
import { QueuesService } from './queues.service';
import { ReenvioWebhookService } from './reenvio-webhook.service';
import { BullBoardAuthMiddleware } from './bull-board.middleware';
import { FilasAlertaService } from './filas-alerta.service';

const queueRegistrations = ALL_QUEUE_NAMES.map((name) =>
  BullModule.registerQueue({ name }),
);

const boardQueues = ALL_QUEUE_NAMES.map((name) =>
  BullBoardModule.forFeature({
    name,
    adapter: BullMQAdapter,
    options: { displayName: nomeExibicaoFila(name) },
  }),
);

@Global()
@Module({})
export class QueuesModule {
  static forRoot(): DynamicModule {
    return {
      module: QueuesModule,
      global: true,
      imports: [
        AuthModule,
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              url: config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
            },
          }),
        }),
        ...queueRegistrations,
        BullBoardModule.forRoot({
          route: '/admin/queues',
          adapter: ExpressAdapter,
          middleware: BullBoardAuthMiddleware,
        }),
        ...boardQueues,
      ],
      providers: [QueuesService, ReenvioWebhookService, BullBoardAuthMiddleware],
      exports: [BullModule, QueuesService, ReenvioWebhookService],
    };
  }

  static forWorker(): DynamicModule {
    return {
      module: QueuesModule,
      global: true,
      imports: [
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: {
              url: config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
            },
          }),
        }),
        ...queueRegistrations,
      ],
      providers: [QueuesService, FilasAlertaService],
      exports: [BullModule, QueuesService],
    };
  }
}

export { QUEUE_NAMES };
