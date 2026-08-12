/**
 * Prefixo global das rotas da API (`/api/...`).
 *
 * Fonte ÚNICA: usado no `setGlobalPrefix` do boot e por quem precisa comparar
 * `req.path` com uma rota escrita "sem prefixo". Enquanto o valor estava só no
 * `main.ts`, a allowlist de 2FA do `JwtAuthGuard` comparava `/auth/me` com o
 * path real `/api/auth/me` e NUNCA casava — o admin sem 2FA levava 403 até nas
 * duas rotas que existem para ele ativar o 2FA, e a conta ficava inutilizável.
 */
export const API_GLOBAL_PREFIX = 'api';

/**
 * Origem pública da API a partir de `API_PUBLIC_URL`.
 *
 * O contrato é "só a origem" (`https://host`), mas em deploy (Render etc.)
 * alguém grava `https://host/api` — e quem monta postback acrescenta `/api/...`
 * de novo → `Cannot POST /api/api/webhooks/...` (404 na liquidante). Aceita
 * os dois formatos e devolve SEMPRE a origem sem path.
 */
export function origemApiPublica(url: string): string {
  let s = url.trim().replace(/\/+$/, '');
  const sufixo = `/${API_GLOBAL_PREFIX}`;
  if (s.toLowerCase().endsWith(sufixo)) {
    s = s.slice(0, -sufixo.length).replace(/\/+$/, '');
  }
  return s;
}

/**
 * `req.path` sem o prefixo global, sem query string e sem barra final —
 * comparável com rotas declaradas como `/auth/me`.
 */
export function rotaSemPrefixo(req: { path?: string; url?: string }): string {
  const bruto = String(req.path ?? req.url ?? '').split('?')[0];
  const semPrefixo = bruto.startsWith(`/${API_GLOBAL_PREFIX}/`)
    ? bruto.slice(API_GLOBAL_PREFIX.length + 1)
    : bruto;
  return semPrefixo.length > 1 && semPrefixo.endsWith('/')
    ? semPrefixo.slice(0, -1)
    : semPrefixo;
}
