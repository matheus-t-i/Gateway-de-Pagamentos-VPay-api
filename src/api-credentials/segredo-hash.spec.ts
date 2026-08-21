import * as argon2 from 'argon2';
import { hashSegredo, verificarSegredo } from './segredo-hash';

/**
 * O guard verificava o segredo com argon2 (m=64MB, t=3, p=4) em TODA
 * requisição: ~87 ms de CPU e 64 MB por chamada, travando o processo em ~73
 * req/s — e, como a chave pública não é secreta, qualquer um podia forçar esse
 * custo mandando segredo errado.
 *
 * A troca por HMAC só é defensável porque o segredo é gerado por nós com 256
 * bits de entropia. Estes testes travam as propriedades que sustentam isso.
 */
describe('segredo de credencial de API', () => {
  const SEGREDO = 'a3f9'.repeat(16); // 64 hex, como o `randomBytes(32)` real

  beforeAll(() => {
    process.env.API_SECRET_PEPPER = 'f'.repeat(64);
  });

  it('aceita o segredo correto e recusa o errado', async () => {
    const hash = hashSegredo(SEGREDO);
    expect(hash.startsWith('hmac1$')).toBe(true);

    expect((await verificarSegredo(hash, SEGREDO)).ok).toBe(true);
    expect((await verificarSegredo(hash, SEGREDO + 'x')).ok).toBe(false);
    expect((await verificarSegredo(hash, 'outro')).ok).toBe(false);
  });

  it('o pepper faz parte do hash: sem ele, o mesmo segredo não confere', async () => {
    const hash = hashSegredo(SEGREDO);
    process.env.API_SECRET_PEPPER = '0'.repeat(64);
    expect((await verificarSegredo(hash, SEGREDO)).ok).toBe(false);
    process.env.API_SECRET_PEPPER = 'f'.repeat(64);
  });

  it('recusa operar sem pepper em vez de aceitar qualquer coisa', () => {
    const salvo = process.env.API_SECRET_PEPPER;
    delete process.env.API_SECRET_PEPPER;
    expect(() => hashSegredo(SEGREDO)).toThrow(/API_SECRET_PEPPER/);
    process.env.API_SECRET_PEPPER = salvo;
  });

  it('verifica hash argon2 legado e sinaliza a migração', async () => {
    const legado = await argon2.hash(SEGREDO);

    const certo = await verificarSegredo(legado, SEGREDO);
    expect(certo.ok).toBe(true);
    // É o gatilho que faz o guard reescrever a linha no formato novo.
    expect(certo.precisaMigrar).toBe(true);

    const errado = await verificarSegredo(legado, 'nao-e-o-segredo');
    expect(errado.ok).toBe(false);
    // Segredo errado não migra nada: não temos o valor em claro correto.
    expect(errado.precisaMigrar).toBe(false);
  });

  it('hash no formato novo não pede migração', async () => {
    const r = await verificarSegredo(hashSegredo(SEGREDO), SEGREDO);
    expect(r.ok).toBe(true);
    expect(r.precisaMigrar).toBe(false);
  });

  it('hash em formato desconhecido é recusado, não aceito por engano', async () => {
    expect((await verificarSegredo('lixo-sem-prefixo', SEGREDO)).ok).toBe(false);
    expect((await verificarSegredo('', SEGREDO)).ok).toBe(false);
  });

  /**
   * O que garante a propriedade é `timingSafeEqual` ser CHAMADO — não o relógio.
   *
   * Antes este caso cronometrava dois candidatos (um que erra só nos últimos
   * dois caracteres, outro que erra desde o primeiro) e exigia razão < 3.
   * Medido: com `===` de volta no lugar do `timingSafeEqual`, a razão dá
   * **1,07**. Ou seja, a regressão que este teste dizia pegar passava VERDE —
   * e ele ainda era instável, porque o cronômetro registrava qualquer pico de
   * carga da máquina como se fosse vazamento de tempo.
   *
   * O motivo é aritmético e não tem conserto por repetição: o HMAC custa
   * ~2,3 µs por chamada e a comparação de 32 bytes desaparece dentro disso.
   * Cronômetro é a ferramenta errada aqui; espiar a chamada é a certa.
   */
  it('a comparação passa por timingSafeEqual, nunca por igualdade de string', async () => {
    const crypto = jest.requireActual('node:crypto') as typeof import('node:crypto');
    const espiao = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      const hash = hashSegredo(SEGREDO);
      const alvo = hash.slice('hmac1$'.length);
      // Erra SÓ nos dois últimos caracteres: é o candidato que um `===` faria
      // demorar mais, e é com ele que se descobre o segredo byte a byte.
      const quaseCerto =
        'hmac1$' + alvo.slice(0, -2) + (alvo.endsWith('00') ? '11' : '00');

      espiao.mockClear();
      expect((await verificarSegredo(hash, SEGREDO)).ok).toBe(true);
      expect(espiao).toHaveBeenCalledTimes(1);
      // Buffers do digest INTEIRO (32 bytes do sha256) — nem string, nem fatia.
      const [a, b] = espiao.mock.calls[0];
      expect(Buffer.isBuffer(a)).toBe(true);
      expect(Buffer.isBuffer(b)).toBe(true);
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);

      // O quase-certo é recusado E TAMBÉM chega na comparação: não sai antes
      // por curto-circuito de string.
      espiao.mockClear();
      expect((await verificarSegredo(quaseCerto, SEGREDO)).ok).toBe(false);
      expect(espiao).toHaveBeenCalledTimes(1);
    } finally {
      espiao.mockRestore();
    }
  });

  it('é ordens de grandeza mais barato que argon2', async () => {
    const hash = hashSegredo(SEGREDO);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) await verificarSegredo(hash, SEGREDO);
    const msPorChamada = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;

    // argon2 media ~27 ms de relógio por chamada neste mesmo caminho.
    expect(msPorChamada).toBeLessThan(1);
  });
});
