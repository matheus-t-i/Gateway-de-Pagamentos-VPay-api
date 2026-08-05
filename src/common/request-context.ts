import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContextStore = {
  identificadorRastreio: string;
  usuarioId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

export function getRastreio(): string {
  return requestContext.getStore()?.identificadorRastreio ?? 'sem-rastreio';
}
