import { restaurarPadraoOculto } from './padrao-sistema-oculto';
import { adquirirTravaSuite, type GlobalComTrava } from './trava-suite';

/**
 * Roda UMA vez, antes de qualquer spec. Duas responsabilidades, NESTA ordem:
 *
 * 1. **Trava de execução única** (`trava-suite.ts`): advisory lock no
 *    Postgres, seguro até o `globalTeardown`. O cliente fica pendurado em
 *    `globalThis` porque setup e teardown rodam no MESMO processo (o principal
 *    do jest), e a trava vive exatamente enquanto essa conexão viver.
 * 2. **Heal do padrão escondido** (`padrao-sistema-oculto.ts`): desfaz o que
 *    uma execução interrompida deixou. DEPOIS da trava, senão o heal de uma
 *    execução "conserta" o banco embaixo da outra, que está no meio do uso.
 *
 * Três desfechos, todos de propósito:
 * - **banco fora do ar** → aviso e a suíte segue: os specs sem banco continuam
 *   valendo, e os com banco já falham sozinhos com a mensagem de conexão certa;
 * - **trava ocupada além da espera** → ERRO com quem segura. Isso é o
 *   comportamento, não acidente: duas suítes no mesmo banco era exatamente a
 *   corrida que este arquivo existe para fechar;
 * - **caminho normal** → trava + heal, em silêncio.
 */
export default async function globalSetup(): Promise<void> {
  // `require` aqui dentro, e não `import` no topo: o jest não carrega o `.env`
  // (quem faz isso nos specs é o `ConfigModule.forRoot()`), então sem isto o
  // PrismaClient subiria sem `DATABASE_URL`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('dotenv') as typeof import('dotenv')).config();
  const url = process.env.DATABASE_URL;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');

  /**
   * `connection_limit=1` é parte do MECANISMO, não tuning: advisory lock
   * pertence à CONEXÃO. Com o pool padrão, o `pg_try_advisory_lock` roda numa
   * conexão qualquer e a trava fica presa a ela sem ninguém controlar qual é;
   * com uma só, a trava vive exatamente enquanto este processo viver — e morre
   * junto, que é a propriedade que interessa.
   */
  const prisma = new PrismaClient(
    url
      ? {
          datasources: {
            db: { url: `${url}${url.includes('?') ? '&' : '?'}connection_limit=1` },
          },
        }
      : undefined,
  );

  /**
   * Ping com RETRY: um blip transitório (container do Postgres reiniciando,
   * max_connections estourado por um instante) não pode degradar a execução
   * INTEIRA para o modo sem trava — três tentativas separam 'banco fora' de
   * 'banco piscou'.
   */
  let pingou = false;
  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa < 3 && !pingou; tentativa++) {
    if (tentativa > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      await prisma.$queryRaw`SELECT 1`;
      pingou = true;
    } catch (erro) {
      ultimoErro = erro;
    }
  }
  if (!pingou) {
    console.warn(
      '[jest] Banco indisponível (3 tentativas) — a suíte segue SEM a trava de ' +
        'execução única e sem o heal do padrão: ' +
        (ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)),
    );
    /**
     * Marcador para os SPECS saberem que a execução está degradada — env
     * atravessa para os workers (eles nascem depois do setup), `globalThis`
     * não. Sem isto, `trava-suite.spec.ts` falharia acusando regressão do
     * MECANISMO quando o problema foi o banco ter piscado no setup.
     */
    process.env.VPAY_SUITE_SEM_TRAVA = '1';
    await prisma.$disconnect().catch(() => undefined);
    return;
  }

  try {
    await adquirirTravaSuite(prisma);
  } catch (erro) {
    // Sem desconectar antes de lançar, a conexão pendente seguraria o processo
    // do jest aberto depois do abort.
    await prisma.$disconnect().catch(() => undefined);
    throw erro;
  }
  (globalThis as GlobalComTrava).__clienteTravaSuite = prisma;

  try {
    const restauradas = await restaurarPadraoOculto(prisma);
    if (restauradas > 0) {
      console.warn(
        `[jest] Restaurei ${restauradas} linha(s) de ` +
          'configuracoes_padrao_pix_usuarios que uma execução interrompida ' +
          'havia deixado escondida(s).',
      );
    }
  } catch (erro) {
    console.warn(
      `[jest] Não deu para checar a linha padrão do banco: ${
        erro instanceof Error ? erro.message : String(erro)
      }`,
    );
  }
}
