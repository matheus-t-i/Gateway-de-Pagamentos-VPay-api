import * as ipaddr from 'ipaddr.js';

function normalizarIp(ip: string): string {
  return ip.replace('::ffff:', '');
}

function ehLoopback(ip: string): boolean {
  const n = normalizarIp(ip).toLowerCase();
  return n === '127.0.0.1' || n === '::1' || n === 'localhost';
}

/**
 * Allowlist de IP dos webhooks de adquirente (Camada 2).
 *
 * Em desenvolvimento, lista vazia libera (DX local). Em produção, lista vazia
 * REJEITA — senão a Camada 2 vira teatro e qualquer IP posta webhook.
 *
 * Postman → localhost chega como `127.0.0.1` / `::1`, NÃO como o IP público
 * do "qual é o meu IP". Com a allowlist da liquidante preenchida, o loopback
 * era recusado e o teste local quebrava. Fora de produção, loopback passa.
 */
export function ipAllowed(clientIp: string, allowed: string[]): boolean {
  const normalized = normalizarIp(clientIp);
  if (process.env.NODE_ENV !== 'production' && ehLoopback(normalized)) {
    return true;
  }
  if (allowed.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }
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

/** Em produção não vaza o IP visto; em local, mostra — é o que desfaz o 401. */
export function mensagemIpNaoPermitido(clientIp: string): string {
  const n = normalizarIp(clientIp);
  if (process.env.NODE_ENV === 'production') {
    return 'IP não permitido para webhook do provedor';
  }
  return `IP não permitido para webhook do provedor (recebido: ${n})`;
}
