/**
 * Cinco contas Valorion = cinco adquirentes na vitrine. Mesma integração,
 * mesma fila genérica (`provider` no payload), saldo individual por conta.
 *
 * Código → env da API key:
 *   valorion    → VALORION_API_KEY
 *   valorion_02 → VALORION_02_API_KEY
 *   … até valorion_05.
 *
 * Token de webhook é UM só (`VALORION_WEBHOOK_TOKEN`) nas cinco rotas.
 */
export const CODIGOS_VALORION = [
  'valorion',
  'valorion_02',
  'valorion_03',
  'valorion_04',
  'valorion_05',
] as const;

export type CodigoValorion = (typeof CODIGOS_VALORION)[number];

export const ROTAS_WEBHOOK_VALORION = CODIGOS_VALORION.map(
  (c) => `webhooks/${c}`,
);

export function ehCodigoValorion(codigo: string): codigo is CodigoValorion {
  return (CODIGOS_VALORION as readonly string[]).includes(codigo);
}

/** `valorion` → `VALORION`; `valorion_02` → `VALORION_02`. */
export function prefixoEnvValorion(codigo: string): string {
  return codigo.replace(/-/g, '_').toUpperCase();
}

export function envApiKeyValorion(codigo: string): string {
  return `${prefixoEnvValorion(codigo)}_API_KEY`;
}

export function nomeExibicaoValorion(codigo: string): string {
  if (codigo === 'valorion') return 'Valorion';
  const n = codigo.replace(/^valorion_/, '');
  return `Valorion ${n}`;
}

/**
 * Extrai o codigo da rota `/webhooks/{codigo}/pix-in|pix-out`.
 * Códigos mais longos primeiro para `valorion` não engolir `valorion_02`.
 */
export function codigoValorionDaRota(path: string): CodigoValorion | undefined {
  const p = `/${path.split('?')[0].replace(/^\/+/, '')}`;
  const ordenados = [...CODIGOS_VALORION].sort((a, b) => b.length - a.length);
  for (const codigo of ordenados) {
    if (
      p.includes(`/webhooks/${codigo}/pix-in`) ||
      p.includes(`/webhooks/${codigo}/pix-out`)
    ) {
      return codigo;
    }
  }
  return undefined;
}
