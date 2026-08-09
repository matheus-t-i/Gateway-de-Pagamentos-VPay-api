import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: processo no ar (orquestrador/load balancer). */
  @Get()
  check() {
    return { status: 'ok', service: 'vpay-api', ts: new Date().toISOString() };
  }

  /**
   * Readiness: Postgres + Redis respondem. Sem isto o deploy marca "saudável"
   * com banco/fila mortos e o dinheiro para de circular sem alarme.
   */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'fail'> = { postgres: 'fail', redis: 'fail' };
    const detalhes: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (e) {
      detalhes.postgres = e instanceof Error ? e.message : String(e);
    }

    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      const pong = await redis.ping();
      if (pong === 'PONG') checks.redis = 'ok';
      else detalhes.redis = `ping=${pong}`;
    } catch (e) {
      detalhes.redis = e instanceof Error ? e.message : String(e);
    } finally {
      redis.disconnect();
    }

    const ok = checks.postgres === 'ok' && checks.redis === 'ok';
    const body = {
      status: ok ? 'ok' : 'degraded',
      service: 'vpay-api',
      checks,
      ...(Object.keys(detalhes).length ? { detalhes } : {}),
      ts: new Date().toISOString(),
    };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
