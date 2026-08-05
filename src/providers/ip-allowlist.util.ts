import * as ipaddr from 'ipaddr.js';

/**
 * Allowlist de IP dos webhooks de adquirente (Camada 2). Lista vazia libera —
 * a trava de verdade em produção é cadastrar os IPs da liquidante no admin.
 */
export function ipAllowed(clientIp: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const normalized = clientIp.replace('::ffff:', '');
  return allowed.some((a) => {
    try {
      if (a === '0.0.0.0/0' || a === '::/0') return true;
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
