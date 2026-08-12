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
import { RetencaoModule } from './retencao/retencao.module';
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
        // Em produção, polling do painel (dashboard/pendências) inundava o
        // Render com access log 2xx+headers — erros sumiam. Sucesso fica
        // silencioso; 4xx/5xx e falhas de negócio continuam visíveis.
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          if (process.env.NODE_ENV === 'production') return 'silent';
          return 'info';
        },
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
            'req.headers["x-vpay-signature"]',
            'res.headers["set-cookie"]',
            'req.body.senha',
            'req.body.password',
            'req.body.codigoTotp',
            'req.body.segredo',
            'req.body.xApiSecret',
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
    IntegracoesModule,
    PixModule,
    MedModule,
    RetencaoModule,
    OpsModule,
    PerfisModule,
    FaturamentoModule,
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
