import { origemApiPublica } from './api-prefix';

describe('origemApiPublica', () => {
  it('mantém a origem limpa', () => {
    expect(origemApiPublica('https://vpay-api.onrender.com')).toBe(
      'https://vpay-api.onrender.com',
    );
    expect(origemApiPublica('https://vpay-api.onrender.com/')).toBe(
      'https://vpay-api.onrender.com',
    );
  });

  it('remove /api final — evita /api/api/webhooks no postback', () => {
    expect(origemApiPublica('https://vpay-api.onrender.com/api')).toBe(
      'https://vpay-api.onrender.com',
    );
    expect(origemApiPublica('https://vpay-api.onrender.com/api/')).toBe(
      'https://vpay-api.onrender.com',
    );
  });
});
