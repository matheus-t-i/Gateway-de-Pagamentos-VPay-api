import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';

/**
 * INCR e EXPIRE no MESMO round-trip. Em dois comandos separados, uma queda
 * entre eles deixa a chave SEM TTL: o contador nunca zera e aquele IP (ou
 * credencial) fica barrado para sempre, até alguém apagar a chave na mão.
 */
const LUA_INCR_COM_TTL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`;

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly log = new Logger(RateLimitService.name);
  private readonly redis: Redis;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.redis = new Redis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    // ioredis emite 'error' de forma assíncrona; sem listener, um Redis fora do
    // ar derruba o processo com unhandled error event.
    this.redis.on('error', (e) => this.log.warn(`Redis do rate limit: ${e.message}`));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  /**
   * `true` = dentro do limite.
   *
   * FALHA ABERTA de propósito: se o Redis cair, o gateway continua atendendo
   * (com aviso no log) em vez de recusar tudo. Rate limit é proteção contra
   * abuso, não parte do fluxo de pagamento — derrubar 100% das cobranças por
   * causa do contador seria transformar uma degradação em indisponibilidade.
   */
  async check(key: string, max: number, windowSec: number): Promise<boolean> {
    try {
      const n = (await this.redis.eval(
        LUA_INCR_COM_TTL,
        1,
        key,
        String(windowSec),
      )) as number;
      return n <= max;
    } catch (e) {
      this.log.error(
        `Rate limit indisponível (${(e as Error).message}) — liberando ${key}`,
      );
      return true;
    }
  }

  /**
   * Teto de TENTATIVAS de autenticação por chave pública, cobrado ANTES de
   * verificar o segredo.
   *
   * A chave pública não é secreta: viaja em todo request e é exibida no painel.
   * Sem este freio, quem tivesse uma podia forçar a verificação criptográfica
   * indefinidamente — o limite normal (60/min) só roda depois, dentro do
   * handler, e requisição inválida nunca chega lá.
   *
   * Conta acerto e erro juntos, e o teto é bem acima do limite operacional
   * (60/min) para nunca atrapalhar quem está integrando de verdade. Vale também
   * para chave inexistente, senão a própria ausência de bloqueio viraria
   * oráculo de existência.
   */
  async checkTentativaAuth(chavePublica: string): Promise<boolean> {
    return this.check(`rl:auth:${chavePublica.slice(0, 64)}`, 120, 60);
  }

  /**
   * A política vive no banco mas muda uma vez por ano — buscá-la a cada
   * requisição colocava um SELECT extra no caminho crítico de TODA chamada da
   * API pública. Cache curto: mudança no painel entra em no máximo 60s.
   */
  private politicaCache: { max: number; window: number; expiraEm: number } | null = null;

  private async politicaCredencial() {
    const agora = Date.now();
    if (this.politicaCache && this.politicaCache.expiraEm > agora) {
      return this.politicaCache;
    }
    let max = 60;
    let window = 60;
    try {
      const politica = await this.prisma.politicaLimiteRequisicoes.findFirst({
        where: { escopo: 'CREDENCIAL_API', ativo: true },
        orderBy: { id: 'asc' },
      });
      max = politica?.quantidadeMaxima ?? max;
      window = politica?.janelaSegundos ?? window;
    } catch (e) {
      this.log.warn(`Política de rate limit indisponível, usando padrão: ${(e as Error).message}`);
    }
    this.politicaCache = { max, window, expiraEm: agora + 60_000 };
    return this.politicaCache;
  }

  async enforceCredential(credencialId: string, ip: string): Promise<void> {
    const { max, window } = await this.politicaCredencial();
    const ok = await this.check(`rl:cred:${credencialId}`, max, window);
    if (ok) return;

    // O registro do evento é auditoria: não pode transformar um 429 em 500 se
    // o insert falhar.
    try {
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
    } catch (e) {
      this.log.error(`Falha ao registrar evento de rate limit: ${(e as Error).message}`);
    }

    /**
     * `HttpException` e não `Error` com `.status`: o Nest identifica erro HTTP
     * pela propriedade `statusCode` (via `HttpException`). Um `Error` cru com
     * `status = 429` não é reconhecido, cai no handler genérico e o lojista
     * recebe **500** — justamente quando a orientação correta seria "reduza o
     * ritmo e repita".
     */
    throw new HttpException(
      'Limite de requisições excedido — reduza o ritmo e repita.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Reserva nonce HMAC (SET NX). `true` = primeira vez; `false` = replay.
   * Fail-open se Redis cair — assinatura ainda protege o body.
   */
  async reservarNonceHmac(credencialId: string, nonce: string): Promise<boolean> {
    try {
      const key = `hmac:nonce:${credencialId}:${nonce}`;
      const ok = await this.redis.set(key, '1', 'EX', 600, 'NX');
      return ok === 'OK';
    } catch (e) {
      this.log.error(
        `Nonce HMAC indisponível (${(e as Error).message}) — liberando`,
      );
      return true;
    }
  }
}
