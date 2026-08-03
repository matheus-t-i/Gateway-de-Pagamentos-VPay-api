import { Injectable } from '@nestjs/common';
import { PaymentProviderPort } from './payment-provider.port';
import { MockPaymentProvider } from './mock/mock.client';

@Injectable()
export class ProviderRegistry {
  private readonly map = new Map<string, PaymentProviderPort>();

  constructor(mock: MockPaymentProvider) {
    this.map.set(mock.code, mock);
  }

  get(code: string): PaymentProviderPort {
    const p = this.map.get(code);
    if (!p) throw new Error(`Provider não registrado: ${code}`);
    return p;
  }

  list(): string[] {
    return [...this.map.keys()];
  }
}
