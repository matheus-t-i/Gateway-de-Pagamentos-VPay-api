import { Injectable } from '@nestjs/common';
import { PaymentProviderPort } from './payment-provider.port';
import { MockPaymentProvider } from './mock/mock.client';
import { ValorionPaymentProvider } from './valorion/valorion.client';

@Injectable()
export class ProviderRegistry {
  private readonly map = new Map<string, PaymentProviderPort>();

  constructor(mock: MockPaymentProvider, valorion: ValorionPaymentProvider) {
    // Mock nunca roteia dinheiro em produção — mesmo que alguém o ative no admin.
    if (process.env.NODE_ENV !== 'production') {
      this.map.set(mock.code, mock);
    }
    this.map.set(valorion.code, valorion);
  }

  get(code: string): PaymentProviderPort {
    if (code === 'mock' && process.env.NODE_ENV === 'production') {
      throw new Error(
        'Provider mock desabilitado em produção — crédito fictício bloqueado',
      );
    }
    const p = this.map.get(code);
    if (!p) throw new Error(`Provider não registrado: ${code}`);
    return p;
  }

  list(): string[] {
    return [...this.map.keys()];
  }
}
