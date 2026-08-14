import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  caminhoSemQuery,
  deveLogarErroHttp,
  mensagemDeHttpException,
} from './pino.config';

/**
 * Nest engole HttpException (400/403/…) e responde JSON sem passar `err` ao
 * pino-http — o access log vira "request completed" sem a mensagem. Busca no
 * Render por "Provedor/conta indisponível" não achava nada.
 *
 * Este filtro loga 4xx de negócio (warn) e 5xx (error) no stdout, com método,
 * path sem query, status, mensagem e correlation id. Não loga body (TOTP,
 * senha, chave PIX).
 */
@Catch(HttpException)
export class HttpExceptionLogFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionLogFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<
      Request & {
        identificadorRastreio?: string;
        mensagemErroHttp?: string;
        codigoErroHttp?: string;
      }
    >();
    const res = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const path = caminhoSemQuery(req);
    const message = mensagemDeHttpException(exception.getResponse());
    const rastreio = req.identificadorRastreio;
    req.mensagemErroHttp = message;
    /**
     * Código estável do erro, para a trilha de `/admin/seguranca` poder
     * agrupar sem depender da frase (que muda com a redação). Prioriza o
     * `erro` dos nossos corpos estruturados (ex.: VALOR_FORA_DO_LIMITE) e cai
     * no `error` padrão do Nest ("Unauthorized", "Bad Request").
     */
    const corpoErro = exception.getResponse();
    if (corpoErro && typeof corpoErro === 'object') {
      const c = corpoErro as { erro?: unknown; error?: unknown };
      const codigo =
        (typeof c.erro === 'string' && c.erro) ||
        (typeof c.error === 'string' && c.error) ||
        undefined;
      if (codigo) req.codigoErroHttp = codigo;
    } else if (typeof corpoErro === 'string') {
      req.codigoErroHttp = exception.name;
    }

    if (deveLogarErroHttp(status, path)) {
      const linha = rastreio
        ? `${req.method} ${path} ${status} ${message} rastreio=${rastreio}`
        : `${req.method} ${path} ${status} ${message}`;
      if (status >= 500) this.logger.error(linha);
      else this.logger.warn(linha);
    }

    const corpo = exception.getResponse();
    res.status(status).json(
      typeof corpo === 'string'
        ? { statusCode: status, message: corpo, error: exception.name }
        : corpo,
    );
  }
}
