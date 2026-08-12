import { decryptCredentials, encryptCredentials } from './crypto.util';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('decryptCredentials', () => {
  const anterior = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });

  afterAll(() => {
    process.env.ENCRYPTION_KEY = anterior;
  });

  it('redonda o que encryptCredentials gravou', () => {
    const blob = encryptCredentials({ apiKey: 'abc' });
    expect(decryptCredentials(blob)).toEqual({ apiKey: 'abc' });
  });

  it('blob vazio vira {} — fallback de env da adquirente', () => {
    expect(decryptCredentials('')).toEqual({});
    expect(decryptCredentials('   ')).toEqual({});
  });

  it('JSON em claro / blob curto vira {} — não quebra a cobrança com IV inválido', () => {
    expect(decryptCredentials('{}')).toEqual({});
  });
});
