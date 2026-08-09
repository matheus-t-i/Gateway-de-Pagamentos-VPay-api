import * as ipaddr from 'ipaddr.js';

/**
 * Allowlist de IP dos webhooks de adquirente (Camada 2).
 *
 * Em desenvolvimento, lista vazia libera (DX local). Em produção, lista vazia
 * REJEITA — senão a Camada 2 vira teatro e qualquer IP posta webhook.
 */
export function ipAllowed(clientIp: string, allowed: string[]): boolean {
  if (allowed.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }
  const normalized = clientIp.replace('::ffff:', '');
  return allowed.some((a) => {
    try {
      if (a === '0.0.0.0/0' || a === '::/0') {
        // Em produção, CIDR aberto anula a allowlist — recusa.
        return process.env.NODE_ENV !== 'production';
      }
      if (a.includes('/')) {
        const cidr = ipaddr.parseCIDR(a);
        const parsed = ipaddr.process(normalized);
        return parsed.kind() === cidr[0].kind() && parsed.match(cidr);
      }
      return ipaddr.process(normalized).toString() === ipaddr.process(a).toString();
    } catch {
      return normalized === a;
    }
  });
}
