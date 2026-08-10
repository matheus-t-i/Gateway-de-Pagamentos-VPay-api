import { UnauthorizedException } from '@nestjs/common';
import { encryptText } from '../common/crypto.util';
import {
  assinarRequestHmac,
  montarPayloadHmac,
  verificarAssinaturaHmacRequest,
} from './request-hmac';

describe('request HMAC B2B', () => {
  const segredo = 'segredo-hmac-de-teste-32bytes!!';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  function cifrado() {
    return encryptText(segredo);
  }

  it('aceita assinatura válida', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce-unico-123456';
    const body = '{"valor":10}';
    const payload = montarPayloadHmac({
      method: 'POST',
      path: '/v1/pix/saques',
      timestamp: ts,
      nonce,
      bodyRaw: body,
    });
    const sig = assinarRequestHmac(segredo, payload);
    expect(() =>
      verificarAssinaturaHmacRequest({
        method: 'POST',
        path: '/v1/pix/saques',
        timestampHeader: ts,
        nonceHeader: nonce,
        signatureHeader: sig,
        bodyRaw: body,
        segredoHmacCriptografado: cifrado(),
      }),
    ).not.toThrow();
  });

  it('recusa timestamp velho', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const nonce = 'nonce-velho-123456';
    const body = '{}';
    const payload = montarPayloadHmac({
      method: 'GET',
      path: '/v1/pix/cobrancas',
      timestamp: ts,
      nonce,
      bodyRaw: body,
    });
    const sig = assinarRequestHmac(segredo, payload);
    expect(() =>
      verificarAssinaturaHmacRequest({
        method: 'GET',
        path: '/v1/pix/cobrancas',
        timestampHeader: ts,
        nonceHeader: nonce,
        signatureHeader: sig,
        bodyRaw: body,
        segredoHmacCriptografado: cifrado(),
      }),
    ).toThrow(UnauthorizedException);
  });
});
