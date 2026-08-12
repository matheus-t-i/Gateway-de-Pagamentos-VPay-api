import {
  CODIGOS_VALORION,
  codigoValorionDaRota,
  envApiKeyValorion,
  nomeExibicaoValorion,
} from './valorion.codigos';
import {
  recusaDefinitivaNoAuth,
  ValorionPaymentProvider,
} from './valorion.client';
import { RecusaAdquirenteError } from '../payment-provider.port';
import { ProviderRegistry } from '../provider.registry';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

describe('Valorion — 5 adquirentes', () => {
  it('mapeia codigo → env da API key', () => {
    expect(envApiKeyValorion('valorion')).toBe('VALORION_API_KEY');
    expect(envApiKeyValorion('valorion_02')).toBe('VALORION_02_API_KEY');
    expect(envApiKeyValorion('valorion_05')).toBe('VALORION_05_API_KEY');
  });

  it('extrai o codigo da rota sem confundir valorion com valorion_02', () => {
    expect(codigoValorionDaRota('/api/webhooks/valorion/pix-in')).toBe(
      'valorion',
    );
    expect(codigoValorionDaRota('webhooks/valorion_02/pix-out')).toBe(
      'valorion_02',
    );
    expect(codigoValorionDaRota('/webhooks/valorion_05/pix-in?token=x')).toBe(
      'valorion_05',
    );
    expect(codigoValorionDaRota('/webhooks/mock/pix-in')).toBeUndefined();
  });

  it('nome de vitrine distingue as contas', () => {
    expect(nomeExibicaoValorion('valorion')).toBe('Valorion');
    expect(nomeExibicaoValorion('valorion_03')).toBe('Valorion 03');
  });

  it('registry registra as 5 (sem fila extra)', () => {
    const mock = { code: 'mock' };
    const reg = new ProviderRegistry(
      mock as never,
      {} as unknown as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
    );
    for (const codigo of CODIGOS_VALORION) {
      expect(reg.get(codigo).code).toBe(codigo);
    }
  });

  it('postbackUrl da conta 02 aponta para a rota dela e usa a API key dela', async () => {
    const visto: { postbackUrl: string; apiKey: string } = {
      postbackUrl: '',
      apiKey: '',
    };
    const config = {
      get: (nome: string) =>
        (
          ({
            VALORION_02_API_KEY: 'chave-da-02',
            API_PUBLIC_URL: 'https://api.teste.local',
            VALORION_WEBHOOK_TOKEN: 'token-unico',
          }) as Record<string, string>
        )[nome],
    } as unknown as ConfigService;
    const provider = new ValorionPaymentProvider(
      {} as unknown as PrismaService,
      config,
      'valorion_02',
    );
    const fetchOriginal = global.fetch;
    global.fetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const corpo = JSON.parse(init.body) as { postbackUrl?: string };
      visto.postbackUrl = String(corpo.postbackUrl ?? '');
      visto.apiKey = init.headers['x-api-key'] ?? '';
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            idTransaction: 'liq-02',
            paymentCode: '00020126...',
          }),
      };
    }) as unknown as typeof fetch;
    try {
      const { Decimal } = await import('decimal.js');
      await provider.createCharge({
        valor: new Decimal('10.00'),
        idTransacaoPrivado: 'priv',
        idTransacaoPublico: 'pub',
        pagador: {
          nome: 'A',
          documento: '52998224725',
          email: 'a@teste.local',
          telefone: '11999998888',
        },
        credenciais: {},
      } as never);
    } finally {
      global.fetch = fetchOriginal;
    }
    expect(visto.postbackUrl).toBe(
      'https://api.teste.local/api/webhooks/valorion_02/pix-in?token=token-unico',
    );
    expect(visto.apiKey).toBe('chave-da-02');
  });

  it('API_PUBLIC_URL com /api no final NÃO duplica o prefixo no postback', async () => {
    const visto = { postbackUrl: '' };
    const config = {
      get: (nome: string) =>
        (
          ({
            VALORION_API_KEY: 'chave',
            API_PUBLIC_URL: 'https://vpay-api.onrender.com/api',
            VALORION_WEBHOOK_TOKEN: 'tok',
          }) as Record<string, string>
        )[nome],
    } as unknown as ConfigService;
    const provider = new ValorionPaymentProvider(
      {} as unknown as PrismaService,
      config,
      'valorion',
    );
    const fetchOriginal = global.fetch;
    global.fetch = (async (_url: string, init: { body: string }) => {
      const corpo = JSON.parse(init.body) as { postbackUrl?: string };
      visto.postbackUrl = String(corpo.postbackUrl ?? '');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            idTransaction: 'liq',
            paymentCode: '00020126...',
          }),
      };
    }) as unknown as typeof fetch;
    try {
      const { Decimal } = await import('decimal.js');
      await provider.createCharge({
        valor: new Decimal('5.00'),
        idTransacaoPrivado: 'priv',
        idTransacaoPublico: 'pub',
        pagador: {
          nome: 'A',
          documento: '52998224725',
          email: 'a@teste.local',
          telefone: '11999998888',
        },
        credenciais: {},
      } as never);
    } finally {
      global.fetch = fetchOriginal;
    }
    expect(visto.postbackUrl).toBe(
      'https://vpay-api.onrender.com/api/webhooks/valorion/pix-in?token=tok',
    );
    expect(visto.postbackUrl).not.toContain('/api/api/');
  });
});

describe('Valorion cash-out — recusa definitiva no auth', () => {
  it('reconhece cash-out desabilitado e X-Pix-Key inválida', () => {
    expect(
      recusaDefinitivaNoAuth(
        new RecusaAdquirenteError(
          'Valorion HTTP 403: {"message":"Cash-out desabilitado para este usuário."}',
        ),
      ),
    ).toBe(true);
    expect(
      recusaDefinitivaNoAuth(
        new RecusaAdquirenteError(
          'Valorion HTTP 401: {"message":"X-Pix-Key inválida"}',
        ),
      ),
    ).toBe(true);
    expect(
      recusaDefinitivaNoAuth(
        new RecusaAdquirenteError(
          'Valorion HTTP 403: {"message":"X-Pix-Key inválida (acesso bloqueado)"}',
        ),
      ),
    ).toBe(true);
  });

  it('401 genérico da API key NÃO é recusa — retry continua permitido', () => {
    expect(
      recusaDefinitivaNoAuth(
        new RecusaAdquirenteError('Valorion HTTP 401: Unauthorized'),
      ),
    ).toBe(false);
  });
});
