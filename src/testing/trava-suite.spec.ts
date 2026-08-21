import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { CHAVE_TRAVA_SUITE } from './trava-suite';

/**
 * A trava de execução única só protege alguém se três coisas forem verdade ao
 * mesmo tempo — e cada uma quebra em silêncio se ninguém a vigiar:
 *
 * 1. **a execução atual SEGURA a trava** (o globalSetup pode regredir e ela
 *    some sem nenhum teste ficar vermelho);
 * 2. **uma segunda execução é RECUSADA** enquanto a primeira vive;
 * 3. **a trava SOLTA quando o processo morre à força** — é a propriedade que
 *    fez o advisory lock ganhar de lock em arquivo. Se um dia a implementação
 *    trocar para algo que deixa órfão, este teste é o único aviso.
 *
 * As provas 2 e 3 usam uma CHAVE PRÓPRIA (a real está ocupada — por nós
 * mesmos) e um processo-filho de verdade (`segurador-trava.js`), morto com
 * SIGKILL: sem chance de handler de saída, igual Ctrl-C/kill -F/queda.
 */
describe('trava de execução única da suíte', () => {
  /** Chave só deste teste — vizinha da real, mas nunca a real. */
  const CHAVE_TESTE = CHAVE_TRAVA_SUITE + 1;

  let prisma: PrismaClient;

  beforeAll(() => {
    // Specs normalmente carregam o .env pelo ConfigModule; aqui é direto.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('dotenv') as typeof import('dotenv')).config();
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * Sonda: a chave está livre? Usa lock de TRANSAÇÃO (`xact`) de propósito —
   * solta sozinho no commit, então a sonda nunca vira ela mesma um segurador
   * esquecido. Session e xact disputam o MESMO espaço de chave, então a sonda
   * enxerga a trava do globalSetup normalmente.
   */
  async function chaveLivre(chave: number): Promise<boolean> {
    const r = await prisma.$transaction((db) =>
      db.$queryRaw<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_xact_lock(0, ${chave}::int) AS ok
      `,
    );
    return r[0].ok;
  }

  it('a execução ATUAL está segurando a trava real', async () => {
    if (process.env.VPAY_SUITE_SEM_TRAVA) {
      /**
       * O globalSetup não alcançou o banco e a suíte rodou DEGRADADA, sem
       * trava — o vermelho aqui é o registro disso, não regressão do
       * mecanismo. Sem esta distinção, um blip de banco no setup viraria
       * caça a um bug que não existe.
       */
      throw new Error(
        'Execução SEM a trava: o banco estava indisponível no globalSetup ' +
          '(veja o aviso no topo da saída). Rode a suíte de novo com o banco ' +
          'de pé — este vermelho é o sinal da degradação, não um bug da trava.',
      );
    }
    expect(await chaveLivre(CHAVE_TRAVA_SUITE)).toBe(false);
  });

  it(
    'segunda execução é recusada enquanto a primeira vive — e liberada quando ela MORRE',
    async () => {
      // Pré-condição: a chave de teste está livre (ninguém esqueceu um segurador).
      expect(await chaveLivre(CHAVE_TESTE)).toBe(true);

      const filho = spawn(
        process.execPath,
        [join(__dirname, 'segurador-trava.js'), String(CHAVE_TESTE)],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const teto = setTimeout(
            () => reject(new Error('segurador não travou em 15 s')),
            15_000,
          );
          let stderr = '';
          filho.stderr!.on('data', (d: Buffer) => (stderr += String(d)));
          filho.on('exit', (codigo) =>
            reject(
              new Error(`segurador morreu antes de travar (código ${codigo}): ${stderr}`),
            ),
          );
          filho.stdout!.on('data', (d: Buffer) => {
            if (String(d).includes('TRAVADO')) {
              clearTimeout(teto);
              resolve();
            }
          });
        });

        // Enquanto o "outro processo" vive, a chave está ocupada.
        expect(await chaveLivre(CHAVE_TESTE)).toBe(false);
      } finally {
        // Morte à força, sem chance de limpeza — o cenário Ctrl-C/kill -F/queda.
        filho.kill('SIGKILL');
      }

      // O Postgres percebe a conexão morta e solta sozinho: sem lock órfão.
      // Pequena espera de cortesia — em localhost a liberação é imediata.
      const fim = Date.now() + 10_000;
      let livre = false;
      while (!livre && Date.now() < fim) {
        livre = await chaveLivre(CHAVE_TESTE);
        if (!livre) await new Promise((r) => setTimeout(r, 200));
      }
      expect(livre).toBe(true);
    },
    30_000,
  );
});
