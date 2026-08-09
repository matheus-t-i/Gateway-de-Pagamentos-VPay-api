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

  it('comparação é em tempo constante (não vaza o segredo byte a byte)', async () => {
    const hash = hashSegredo(SEGREDO);
    const alvo = hash.slice('hmac1$'.length);

    // Um candidato que acerta quase todo o hash e outro que erra desde o
    // primeiro byte. Com `===`, o primeiro demoraria mais.
    const quaseCerto = 'hmac1$' + alvo.slice(0, -2) + (alvo.endsWith('00') ? '11' : '00');
    const totalmenteErrado = 'hmac1$' + 'f'.repeat(alvo.length);

    const medir = async (h: string) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 3000; i++) await verificarSegredo(h, SEGREDO);
      return Number(process.hrtime.bigint() - t0) / 3000;
    };

    const tQuase = await medir(quaseCerto);
    const tErrado = await medir(totalmenteErrado);

    // Ambos falham...
    expect((await verificarSegredo(quaseCerto, SEGREDO)).ok).toBe(false);
    expect((await verificarSegredo(totalmenteErrado, SEGREDO)).ok).toBe(false);
    // ...e em tempo equivalente. Margem larga porque é medição em máquina com
    // ruído: o que se quer pegar é diferença de ORDEM de grandeza, sintoma de
    // `===` ter voltado.
    const razao = Math.max(tQuase, tErrado) / Math.min(tQuase, tErrado);
    expect(razao).toBeLessThan(3);
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
