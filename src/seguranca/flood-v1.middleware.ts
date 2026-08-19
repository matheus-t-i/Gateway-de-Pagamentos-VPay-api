import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RateLimitService } from '../api-credentials/rate-limit.service';
import { extrairIpCliente } from '../common/client-ip.util';
import { rotaSemPrefixo } from '../common/api-prefix';
import { ehRotaSensivel } from './registro-acesso-api.middleware';

/**
 * Teto de flood por IP em `/v1/*` ANTES do roteamento.
 *
 * O `IpThrottleGuard` global só roda quando um handler CASA — rota inexistente
 * não passa por guard nenhum. A trilha de segurança, porém, é `app.use` cru e
 * roda sempre: cada 404 de rota desconhecida virava um INSERT em
 * `registros_acesso_api` para requisição sem credencial, sem limite algum —
 * exatamente o que a varredura de 17/08/2026 explorou. Este middleware fecha o
 * buraco: acima do teto, o 429 sai ANTES de a trilha registrar o gancho de
 * gravação, então o flood para de escrever no banco. As primeiras linhas do
 * minuto continuam gravadas — sinal forense suficiente para a tela.
 *
 * O teto soma TODAS as rotas `/v1` do IP, por isso é folgado: o guard já limita
 * 300/rota/min, e um lojista movimentado (ou dois atrás do mesmo IP de egress)
 * distribui carga por várias rotas ao mesmo tempo. 1200/min fica ACIMA do uso
 * legítimo plausível e ainda barra a varredura antes de ela virar milhares de
 * INSERT — mais apertado que isso recusaria cliente real no caminho do dinheiro
 * sem que ele estivesse abusando. FALHA ABERTA como todo rate limit daqui
 * (`RateLimitService.check`): Redis fora do ar degrada a proteção, não derruba
 * cobrança.
 *
 * ⚠️ **O 429 daqui sai ANTES da trilha** (de propósito: é o que impede o INSERT
 * ilimitado), então ele não aparece em `/admin/seguranca`. Para o flood não
 * ficar 100% invisível, registra um `warn` — mas só UMA vez por minuto por IP
 * (`:v1-flood-log`, limite 1/60s), senão o próprio log vira flood.
 */
@Injectable()
export class FloodV1Middleware implements NestMiddleware {
  private readonly logger = new Logger(FloodV1Middleware.name);

  /** Teto agregado por IP em todo o `/v1`. Acima do uso legítimo, abaixo de scan. */
  private readonly teto = { limit: 1200, windowSec: 60 };

  constructor(private readonly rateLimit: RateLimitService) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (!ehRotaSensivel(rotaSemPrefixo(req))) return next();

    const ip = extrairIpCliente(req) || 'desconhecido';
    this.rateLimit
      .check(`rl:ip:${ip}:v1-pre`, this.teto.limit, this.teto.windowSec)
      .then(async (dentro) => {
        if (dentro) return next();
        // 1 log por minuto por IP: o suporte enxerga o flood sem afogar o stdout.
        if (await this.rateLimit.check(`rl:ip:${ip}:v1-flood-log`, 1, 60)) {
          this.logger.warn(
            `teto /v1 estourado por ${ip} (${req.method} ${req.originalUrl ?? req.url}) — 429 pré-roteamento`,
          );
        }
        res.status(429).json({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Muitas requisições. Aguarde um momento e tente novamente.',
        });
      })
      // `check` já falha aberta; isto cobre qualquer surpresa sem derrubar a chamada.
      .catch(() => next());
  }
}
