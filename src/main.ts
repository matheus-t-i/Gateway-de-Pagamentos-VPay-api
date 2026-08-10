import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { validarAmbiente } from './common/env.validation';
import { API_GLOBAL_PREFIX } from './common/api-prefix';

// Rede de segurança: ids do Prisma são BigInt e JSON.stringify lança
// "Do not know how to serialize a BigInt" (vira 500). Controllers devem mapear
// explicitamente; isto evita erro silencioso em qualquer rota futura.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  // Fail-fast: melhor não subir do que subir com segredo de exemplo.
  validarAmbiente(process.env);

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Parser próprio abaixo, com limite explícito de corpo.
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));

  // Corpo JSON limitado: payload gigante é vetor de DoS. Multipart (upload) não
  // passa por aqui — é tratado pelo multer (FileInterceptor) com limite próprio.
  // `rawBody` alimenta a verificação HMAC B2B (assinatura do body original).
  app.use(
    json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Cabeçalhos de segurança (HSTS, nosniff, frame-options, etc.). A API é JSON,
  // mas também serve o Bull Board (/admin/queues) — um app React same-origin que
  // busca dados e traduções via XHR. helmet não tem connect-src próprio: sem
  // declará-lo, ele cai no default-src 'none' e bloqueia todo XHR, deixando o
  // painel de filas sem dados e mostrando as chaves de i18n cruas.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          connectSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Hardening: não anunciar o framework; atrás de proxy (Render) confiar no
  // X-Forwarded-For para que req.ip (allowlists/auditoria) seja o IP real.
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') {
    // Exatamente 1 hop: confiar em mais permitiria forjar X-Forwarded-For.
    express.set('trust proxy', 1);
  }

  app.enableCors({
    origin: process.env.WEB_URL ?? 'http://localhost:3000',
    credentials: true,
  });
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: ['health', 'health/(.*)', 'admin/queues', 'admin/queues/(.*)'],
  });

  // SIGTERM do Render precisa fechar Prisma e Workers BullMQ; sem isto jobs em
  // voo morrem no meio a cada deploy.
  app.enableShutdownHooks();

  // Render injeta PORT; API_PORT é o nome local.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  const logger = app.get(Logger);
  logger.log(`API listening on :${port}`);
}

bootstrap();
