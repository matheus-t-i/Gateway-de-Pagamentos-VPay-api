import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';

type ReqComContexto = IncomingMessage & {
  originalUrl?: string;
  url?: string;
  method?: string;
  identificadorRastreio?: string;
  mensagemErroHttp?: string;
};

/** Path sem query — o token do postback Valorion (`?token=`) não pode ir ao log. */
export function caminhoSemQuery(req: {
  originalUrl?: string;
  url?: string;
}): string {
  const raw = req.originalUrl ?? req.url ?? '';
  return raw.split('?')[0] || '/';
}

/**
 * pino-http compartilhado pela API e pelo worker.
 *
 * Em produção o transport pretty SOME: o Render Starter só mostra stdout do
 * Docker, e o JSON do pino cai direto no stream. `LOG_LEVEL=error` esconde
 * warn — 400 de negócio some. Default `info` para o warn de 4xx aparecer.
 */
export function pinoHttpOptions(): Options {
  const producao = process.env.NODE_ENV === 'production';
  return {
    level: process.env.LOG_LEVEL || 'info',
    transport: producao
      ? undefined
      : { target: 'pino-pretty', options: { singleLine: true } },
    quietReqLogger: true,
    // Polling 2xx do painel inundava o Render; sucesso em prod fica silencioso.
    // 4xx = warn (pesquisável); 5xx = error. Nest trata HttpException como
    // "request completed" — sem customSuccessMessage a mensagem de negócio
    // (ex. "Provedor/conta indisponível") NÃO entra no access log.
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      if (producao) return 'silent';
      return 'info';
    },
    customSuccessMessage: (req, res) => {
      const r = req as ReqComContexto;
      const path = caminhoSemQuery(r);
      if (res.statusCode >= 400) {
        const extra = r.mensagemErroHttp;
        return extra
          ? `${r.method} ${path} ${res.statusCode} ${extra}`
          : `${r.method} ${path} ${res.statusCode}`;
      }
      return 'request completed';
    },
    customErrorMessage: (req, res, err) => {
      const r = req as ReqComContexto;
      return `${r.method} ${caminhoSemQuery(r)} ${res.statusCode} ${err.message}`;
    },
    customProps: (req) => {
      const r = req as ReqComContexto;
      return r.identificadorRastreio ? { rastreio: r.identificadorRastreio } : {};
    },
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
  };
}

export function deveLogarErroHttp(status: number, path: string): boolean {
  if (path === '/health' || path.startsWith('/health/')) return false;
  // 401 é ruído (token expirado, probe sem auth). 403/400/5xx importam.
  if (status === 401) return false;
  return status >= 400;
}

export function mensagemDeHttpException(resposta: unknown): string {
  if (typeof resposta === 'string') return resposta;
  if (resposta && typeof resposta === 'object' && 'message' in resposta) {
    const m = (resposta as { message: unknown }).message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.filter((x) => typeof x === 'string').join('; ');
  }
  return 'Erro na requisição';
}
