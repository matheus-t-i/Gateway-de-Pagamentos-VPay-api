import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitService } from '../api-credentials/rate-limit.service';

type Limite = { limit: number; windowSec: number };

export const THROTTLE_KEY = 'throttle:ip';

/**
 * Limite por IP para a rota. Use nas rotas PÚBLICAS (sem JWT) que são alvo de
 * brute force / flood: login, cadastro, reset, onboarding. Ex.:
 *   @Throttle({ limit: 10, windowSec: 60 })
 */
export const Throttle = (limite: Limite) => SetMetadata(THROTTLE_KEY, limite);

/**
 * Rate limit por IP+rota usando o Redis já existente (RateLimitService).
 * Aplicado globalmente com um teto anti-DDoS; rotas sensíveis apertam o limite
 * via @Throttle. Sem isto, as rotas públicas aceitavam >1000 req/s de uma única
 * origem (brute force distribuído e flood de e-mail passavam livres).
 */
@Injectable()
export class IpThrottleGuard implements CanActivate {
  /** Teto global por IP (proteção grosseira contra flood). */
  private readonly padrao: Limite = { limit: 300, windowSec: 60 };

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const limite =
      this.reflector.getAllAndOverride<Limite>(THROTTLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? this.padrao;

    // req.ip depende de trust proxy (validado no boot para produção).
    const ip = (req.ip || 'desconhecido').replace('::ffff:', '');
    // Identifica a rota pelo handler para não misturar contadores entre rotas.
    const rota = `${context.getClass().name}.${context.getHandler().name}`;
    const chave = `rl:ip:${ip}:${rota}`;

    const dentro = await this.rateLimit.check(chave, limite.limit, limite.windowSec);
    if (!dentro) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Muitas requisições. Aguarde um momento e tente novamente.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
