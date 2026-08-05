import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { TracingInterceptor } from './common/tracing.interceptor';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { IpThrottleGuard } from './common/ip-throttle.guard';
import { AuthModule } from './auth/auth.module';
import { ApiCredentialsModule } from './api-credentials/api-credentials.module';
import { ContingenciaModule } from './contingencia/contingencia.module';
import { LedgerModule } from './ledger/ledger.module';
import { QueuesModule } from './queues/queues.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { EmailModule } from './email/email.module';
import { ProvidersModule } from './providers/providers.module';
import { PixModule } from './pix/pix.module';
import { MedModule } from './med/med.module';
import { OpsModule } from './ops/ops.module';
import { PerfisModule } from './perfis/perfis.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        quietReqLogger: true,
        // O serializer padrão do pino copia req.headers inteiro: sem isto,
        // token JWT, segredo de API e x-key do provedor vão em texto claro
        // para o log de TODA requisição.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-secret"]',
            'req.headers["x-secret-key"]',
            'req.headers["x-api-key"]',
            'req.headers["x-key"]',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    PrismaModule,
    EmailModule,
    AuthModule,
    OnboardingModule,
    ApiCredentialsModule,
    ContingenciaModule,
    LedgerModule,
    QueuesModule.forRoot(),
    ProvidersModule,
    PixModule,
    MedModule,
    OpsModule,
    PerfisModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    // Teto anti-flood por IP em TODA rota; rotas públicas apertam via @Throttle.
    {
      provide: APP_GUARD,
      useClass: IpThrottleGuard,
    },
  ],
})
export class AppModule {}
