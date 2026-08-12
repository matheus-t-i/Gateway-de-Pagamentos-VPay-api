import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentProviderPort } from './payment-provider.port';
import { MockPaymentProvider } from './mock/mock.client';
import { ValorionPaymentProvider } from './valorion/valorion.client';
import { CODIGOS_VALORION } from './valorion/valorion.codigos';

@Injectable()
export class ProviderRegistry {
  private readonly map = new Map<string, PaymentProviderPort>();

  constructor(
    mock: MockPaymentProvider,
    prisma: PrismaService,
    config: ConfigService,
  ) {
    // Mock nunca roteia dinheiro em produção — mesmo que alguém o ative no admin.
    if (process.env.NODE_ENV !== 'production') {
      this.map.set(mock.code, mock);
    }
    for (const codigo of CODIGOS_VALORION) {
      this.map.set(codigo, new ValorionPaymentProvider(prisma, config, codigo));
    }
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
