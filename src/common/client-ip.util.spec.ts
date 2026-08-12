import { extrairIpCliente } from './client-ip.util';

describe('extrairIpCliente', () => {
  it('prefere cf-connecting-ip ao req.ip (Cloudflare + Render)', () => {
    expect(
      extrairIpCliente({
        ip: '104.23.160.124',
        headers: {
          'cf-connecting-ip': '74.220.48.180',
          'x-forwarded-for': '74.220.48.180, 104.23.160.124',
        },
      }),
    ).toBe('74.220.48.180');
  });

  it('usa true-client-ip quando cf-connecting-ip ausente', () => {
    expect(
      extrairIpCliente({
        ip: '104.23.160.124',
        headers: { 'true-client-ip': '74.220.56.10' },
      }),
    ).toBe('74.220.56.10');
  });

  it('ignora header CF inválido e cai em req.ip', () => {
    expect(
      extrairIpCliente({
        ip: '127.0.0.1',
        headers: { 'cf-connecting-ip': 'not-an-ip' },
      }),
    ).toBe('127.0.0.1');
  });

  it('remove prefixo IPv4-mapeado', () => {
    expect(
      extrairIpCliente({
        ip: '::ffff:10.0.0.1',
        headers: { 'cf-connecting-ip': '::ffff:74.220.48.180' },
      }),
    ).toBe('74.220.48.180');
  });

  it('sem headers de CF, usa req.ip', () => {
    expect(extrairIpCliente({ ip: '203.0.113.9', headers: {} })).toBe(
      '203.0.113.9',
    );
  });
});
