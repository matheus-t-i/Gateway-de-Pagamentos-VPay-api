import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.redis = new Redis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async check(key: string, max: number, windowSec: number): Promise<boolean> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSec);
    return n <= max;
  }

  async enforceCredential(credencialId: string, ip: string): Promise<void> {
    const politica = await this.prisma.politicaLimiteRequisicoes.findFirst({
      where: { escopo: 'CREDENCIAL_API', ativo: true },
      orderBy: { id: 'asc' },
    });
    const max = politica?.quantidadeMaxima ?? 60;
    const window = politica?.janelaSegundos ?? 60;
    const ok = await this.check(`rl:cred:${credencialId}`, max, window);
    if (!ok) {
      await this.prisma.eventoSeguranca.create({
        data: {
          credencialApiId: BigInt(credencialId),
          tipoEvento: 'RATE_LIMIT',
          severidade: 'MEDIA',
          enderecoIp: ip,
          quantidadeDetectada: max + 1,
          janelaSegundos: window,
          acaoAplicada: 'HTTP_429',
        },
      });
      const err = new Error('Rate limit excedido');
      (err as Error & { status: number }).status = 429;
      throw err;
    }
  }
}
