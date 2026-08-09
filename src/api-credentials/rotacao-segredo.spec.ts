import * as argon2 from 'argon2';
import { hashSegredo, verificarSegredo } from './segredo-hash';

/**
 * Rotação de segredo sem downtime: durante a janela, o segredo NOVO e o ANTIGO
 * valem ao mesmo tempo. É o que permite girar a chave em produção — e o que dá
 * vida útil finita a um segredo vazado.
 *
 * Estes testes exercitam a lógica que o `CredencialAuthService` executa na
 * emissão do token (`POST /v1/auth/token`), incluindo a
 * armadilha que quebraria a rotação em silêncio.
 */
describe('rotação de segredo de credencial de API', () => {
  const ANTIGO = 'a'.repeat(64);
  const NOVO = 'b'.repeat(64);

  beforeAll(() => {
    process.env.API_SECRET_PEPPER = 'f'.repeat(64);
  });

  /** Reproduz a decisão do guard: aceita o atual ou o anterior ainda vigente. */
  async function autenticar(
    cred: {
      segredoHash: string;
      segredoHashAnterior?: string | null;
      segredoAnteriorExpiraEm?: Date | null;
    },
    segredo: string,
  ) {
    let { ok, precisaMigrar } = await verificarSegredo(cred.segredoHash, segredo);
    if (!ok && cred.segredoHashAnterior) {
      const aindaVale =
        !cred.segredoAnteriorExpiraEm || cred.segredoAnteriorExpiraEm > new Date();
      if (aindaVale) {
        const anterior = await verificarSegredo(cred.segredoHashAnterior, segredo);
        if (anterior.ok) {
          ok = true;
          precisaMigrar = false;
        }
      }
    }
    return { ok, precisaMigrar };
  }

  const emJanela = () => ({
    segredoHash: hashSegredo(NOVO),
    segredoHashAnterior: hashSegredo(ANTIGO),
    segredoAnteriorExpiraEm: new Date(Date.now() + 7 * 86400_000),
  });

  it('durante a janela, os DOIS segredos funcionam', async () => {
    const cred = emJanela();
    expect((await autenticar(cred, NOVO)).ok).toBe(true);
    expect((await autenticar(cred, ANTIGO)).ok).toBe(true);
  });

  it('um terceiro segredo qualquer continua recusado', async () => {
    const cred = emJanela();
    expect((await autenticar(cred, 'c'.repeat(64))).ok).toBe(false);
  });

  it('expirada a janela, só o novo vale', async () => {
    const cred = {
      ...emJanela(),
      segredoAnteriorExpiraEm: new Date(Date.now() - 1000),
    };
    expect((await autenticar(cred, NOVO)).ok).toBe(true);
    expect((await autenticar(cred, ANTIGO)).ok).toBe(false);
  });

  it('encerrada a janela na mão, o antigo para na hora', async () => {
    const cred = {
      segredoHash: hashSegredo(NOVO),
      segredoHashAnterior: null,
      segredoAnteriorExpiraEm: null,
    };
    expect((await autenticar(cred, NOVO)).ok).toBe(true);
    expect((await autenticar(cred, ANTIGO)).ok).toBe(false);
  });

  /**
   * A armadilha: com hash ANTERIOR em argon2 legado, `verificarSegredo` devolve
   * `precisaMigrar: true`. Se o guard obedecesse, reescreveria o `segredoHash`
   * ATUAL com o hash do segredo ANTIGO — desfazendo a rotação sozinho e
   * derrubando o segredo novo que o lojista acabou de instalar.
   */
  it('usar o segredo antigo NUNCA dispara migração do hash atual', async () => {
    const cred = {
      segredoHash: hashSegredo(NOVO),
      segredoHashAnterior: await argon2.hash(ANTIGO),
      segredoAnteriorExpiraEm: new Date(Date.now() + 7 * 86400_000),
    };

    const r = await autenticar(cred, ANTIGO);
    expect(r.ok).toBe(true);
    expect(r.precisaMigrar).toBe(false);
  });

  it('o hash ATUAL em argon2 legado ainda migra normalmente', async () => {
    const cred = {
      segredoHash: await argon2.hash(NOVO),
      segredoHashAnterior: null,
      segredoAnteriorExpiraEm: null,
    };
    const r = await autenticar(cred, NOVO);
    expect(r.ok).toBe(true);
    expect(r.precisaMigrar).toBe(true);
  });

  it('rotacionar de novo descarta o intermediário: só dois segredos vivem por vez', async () => {
    // 1ª rotação: ANTIGO -> NOVO
    const primeira = emJanela();
    // 2ª rotação: o NOVO vira anterior e entra um TERCEIRO.
    const TERCEIRO = 'd'.repeat(64);
    const segunda = {
      segredoHash: hashSegredo(TERCEIRO),
      segredoHashAnterior: primeira.segredoHash,
      segredoAnteriorExpiraEm: new Date(Date.now() + 7 * 86400_000),
    };

    expect((await autenticar(segunda, TERCEIRO)).ok).toBe(true);
    expect((await autenticar(segunda, NOVO)).ok).toBe(true);
    // O primeiro sai de circulação — senão a janela viraria acúmulo.
    expect((await autenticar(segunda, ANTIGO)).ok).toBe(false);
  });
});
