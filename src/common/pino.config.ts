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

/** Chaves de query cujo VALOR é segredo e não pode ir ao log em claro. */
const QUERY_SENSIVEL = /token|secret|senha|password|assinatura|signature|apikey/i;

function censurarQuery(query: unknown): Record<string, unknown> | undefined {
  if (!query || typeof query !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    out[k] = QUERY_SENSIVEL.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

/**
 * Serializer de request do pino-http.
 *
 * O serializer PADRÃO grava `req.url` COM a query string — e o postback da
 * Valorion carrega o `VALORION_WEBHOOK_TOKEN` em `?token=` (Camada 2). Sem isto,
 * todo postback que caísse em 4xx/5xx (ou 2xx fora de produção) gravava o token
 * em claro no stdout do Render: segredo único das adquirentes, sem rotação,
 * vazando com carimbo de log. O `redact` cobre só `req.headers.*`/`req.body.*`,
 * não `req.url`/`req.query`. Aqui o `url` sai sem query e a query tem os campos
 * sensíveis censurados; os headers seguem para o `redact` fazer o resto.
 */
export function serializarRequest(req: {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: unknown;
  query?: unknown;
  remoteAddress?: string;
  remotePort?: number;
}): Record<string, unknown> {
  return {
    method: req.method,
    url: caminhoSemQuery(req),
    query: censurarQuery(req.query),
    headers: req.headers,
    remoteAddress: req.remoteAddress,
    remotePort: req.remotePort,
  };
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
    // Reescreve `req` para o token do postback (`?token=`) nunca ir ao log; o
    // `redact` abaixo continua cuidando dos headers/body.
    serializers: { req: serializarRequest },
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
