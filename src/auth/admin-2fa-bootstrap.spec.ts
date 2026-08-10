import { rotaSemPrefixo, API_GLOBAL_PREFIX } from '../common/api-prefix';

/**
 * O admin sem 2FA PRECISA conseguir ativar o 2FA.
 *
 * A allowlist do `JwtAuthGuard` (`ROTAS_SEM_2FA_ADMIN`) é escrita sem o prefixo
 * global (`/auth/me`), mas o path real chega com ele (`/api/auth/me`), porque
 * a app monta tudo sob `setGlobalPrefix`. Comparando o path CRU, nada casava:
 * o admin recém-criado levava 403 em `GET /api/auth/me` — a primeira chamada
 * que o painel faz — e também em `/api/auth/totp/*`, as rotas do setup. Ou
 * seja: para ativar o 2FA era preciso entrar, e para entrar era preciso o 2FA.
 * Conta de administrador inutilizável, sem caminho de saída pelo produto.
 *
 * Este spec trava a normalização do path e a lista de rotas de escape.
 */
describe('bootstrap de 2FA do admin — allowlist casa com o path real', () => {
  /** Cópia da lista do guard: se divergirem, este spec perde o sentido. */
  const ROTAS_SEM_2FA_ADMIN = ['/auth/me', '/auth/totp'];

  const liberado = (pathReal: string) => {
    const path = rotaSemPrefixo({ path: pathReal });
    return ROTAS_SEM_2FA_ADMIN.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
  };

  it('as rotas de escape passam COM o prefixo global (o caso do bug)', () => {
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/me`)).toBe(true);
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/totp/iniciar`)).toBe(true);
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/totp/confirmar`)).toBe(true);
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/totp/desabilitar`)).toBe(true);
  });

  it('continuam passando SEM prefixo (montagem alternativa/testes)', () => {
    expect(liberado('/auth/me')).toBe(true);
    expect(liberado('/auth/totp/iniciar')).toBe(true);
  });

  it('query string e barra final não mudam a decisão', () => {
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/me?x=1`)).toBe(true);
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/me/`)).toBe(true);
  });

  it('o resto do painel continua BARRADO sem 2FA', () => {
    for (const rota of [
      '/painel/dashboard',
      '/painel/transacoes',
      '/admin/usuarios',
      '/admin/med',
      '/painel/credenciais',
    ]) {
      expect(liberado(`/${API_GLOBAL_PREFIX}${rota}`)).toBe(false);
    }
  });

  /**
   * Prefixo-como-substring não pode virar bypass: `/auth/mentiras` começa com
   * `/auth/me` em texto, mas é outra rota.
   */
  it('rota que só COMEÇA com o texto de uma liberada não passa', () => {
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/mentiras`)).toBe(false);
    expect(liberado(`/${API_GLOBAL_PREFIX}/auth/totpx`)).toBe(false);
  });
});
