import { ipAllowed } from './ip-allowlist.util';

describe('ipAllowed', () => {
  const env = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('em desenvolvimento, loopback passa mesmo com allowlist da liquidante', () => {
    process.env.NODE_ENV = 'development';
    const allow = ['74.220.48.0/24', '179.51.222.199'];
    expect(ipAllowed('127.0.0.1', allow)).toBe(true);
    expect(ipAllowed('::1', allow)).toBe(true);
    expect(ipAllowed('::ffff:127.0.0.1', allow)).toBe(true);
  });

  it('em produção, loopback só passa se estiver na lista', () => {
    process.env.NODE_ENV = 'production';
    expect(ipAllowed('127.0.0.1', ['179.51.222.199'])).toBe(false);
    expect(ipAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  it('casa o IP público da allowlist', () => {
    process.env.NODE_ENV = 'development';
    expect(ipAllowed('179.51.222.199', ['179.51.222.199'])).toBe(true);
    expect(ipAllowed('1.2.3.4', ['179.51.222.199'])).toBe(false);
  });

  it('casa CIDR /24 (Valorion Nuvende)', () => {
    process.env.NODE_ENV = 'production';
    const allow = ['74.220.48.0/24', '74.220.56.0/24'];
    expect(ipAllowed('74.220.48.180', allow)).toBe(true);
    expect(ipAllowed('74.220.56.1', allow)).toBe(true);
    expect(ipAllowed('104.23.160.124', allow)).toBe(false);
  });
});
