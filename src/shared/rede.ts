import * as ipaddr from 'ipaddr.js';

/**
 * Normaliza um IP ou faixa CIDR (IPv4 e IPv6). Devolve `null` quando o valor
 * não é um endereço válido.
 *
 * Existe porque allowlist com entrada inválida falha **em silêncio**: a
 * comparação cai no `===` de string, nenhum IP real casa e a credencial para de
 * funcionar sem nada explicar. Melhor recusar no cadastro.
 */
export function normalizarIpOuCidr(valor: string): string | null {
  const v = valor.trim();
  if (!v) return null;
  try {
    if (v.includes('/')) {
      const [addr, prefixo] = ipaddr.parseCIDR(v);
      return `${addr.toString()}/${prefixo}`;
    }
    return ipaddr.parse(v).toString();
  } catch {
    return null;
  }
}
