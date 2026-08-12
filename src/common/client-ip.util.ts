import * as ipaddr from 'ipaddr.js';

type ReqComIp = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function primeiroHeader(
  headers: ReqComIp['headers'],
  nome: string,
): string | undefined {
  if (!headers) return undefined;
  const bruto = headers[nome] ?? headers[nome.toLowerCase()];
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  if (typeof valor !== 'string') return undefined;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : undefined;
}

function ipValido(ip: string): boolean {
  try {
    ipaddr.process(ip.replace(/^::ffff:/i, ''));
    return true;
  } catch {
    return false;
  }
}

/**
 * IP do cliente atrás de Cloudflare + Render (ou proxy similar).
 *
 * Cadeia típica: Cliente → Cloudflare → Render → Nest. Com `TRUST_PROXY=1`,
 * o Express confia só no hop imediato e `req.ip` vira o edge da Cloudflare
 * (ex. `104.23.*` no X-Forwarded-For), não o originador (`74.220.*`).
 *
 * Cloudflare sobrescreve `cf-connecting-ip` / `true-client-ip` — quando
 * presentes e válidos, são a fonte correta para allowlist de webhook.
 * Sem esses headers, cai em `req.ip` (dev local / proxy sem CF).
 */
export function extrairIpCliente(req: ReqComIp): string {
  const cf = primeiroHeader(req.headers, 'cf-connecting-ip');
  if (cf && ipValido(cf)) return cf.replace(/^::ffff:/i, '');

  const trueClient = primeiroHeader(req.headers, 'true-client-ip');
  if (trueClient && ipValido(trueClient)) {
    return trueClient.replace(/^::ffff:/i, '');
  }

  return (req.ip ?? '127.0.0.1').replace(/^::ffff:/i, '');
}
