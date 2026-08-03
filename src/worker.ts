import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';
import { QueuesService } from './queues/queues.service';
import { validarAmbiente } from './common/env.validation';

async function bootstrap() {
  validarAmbiente(process.env);

  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  // Sem os hooks, o SIGTERM do deploy mata jobs de crédito/saque no meio.
  // Com eles, os Workers BullMQ terminam o job em voo antes de sair.
  app.enableShutdownHooks();

  const queues = app.get(QueuesService);
  await queues.ensureRepeatables();
  const logger = app.get(Logger);
  logger.log('Worker BullMQ iniciado');
}

bootstrap();
