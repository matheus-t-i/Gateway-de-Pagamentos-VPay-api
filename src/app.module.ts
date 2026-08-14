import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { TracingInterceptor } from './common/tracing.interceptor';
import { HttpExceptionLogFilter } from './common/http-exception-log.filter';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { pinoHttpOptions } from './common/pino.config';
import { IpThrottleGuard } from './common/ip-throttle.guard';
import { AuthModule } from './auth/auth.module';
import { ApiCredentialsModule } from './api-credentials/api-credentials.module';
import { ContingenciaModule } from './contingencia/contingencia.module';
import { IntegracoesModule } from './integracoes/integracoes.module';
import { LedgerModule } from './ledger/ledger.module';
import { QueuesModule } from './queues/queues.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { EmailModule } from './email/email.module';
import { ProvidersModule } from './providers/providers.module';
import { PixModule } from './pix/pix.module';
import { MedModule } from './med/med.module';
import { OpsModule } from './ops/ops.module';
import { PerfisModule } from './perfis/perfis.module';
import { FaturamentoModule } from './faturamento/faturamento.module';
import { SegurancaModule } from './seguranca/seguranca.module';
import { RetencaoModule } from './retencao/retencao.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: pinoHttpOptions(),
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
    IntegracoesModule,
    PixModule,
    MedModule,
    RetencaoModule,
    OpsModule,
    PerfisModule,
    FaturamentoModule,
    SegurancaModule,
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
    {
      provide: APP_FILTER,
      useClass: HttpExceptionLogFilter,
    },
    // Teto anti-flood por IP em TODA rota; rotas públicas apertam via @Throttle.
    {
      provide: APP_GUARD,
      useClass: IpThrottleGuard,
    },
  ],
})
export class AppModule {}
