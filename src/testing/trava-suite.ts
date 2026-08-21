import type { PrismaClient } from '@prisma/client';

/**
 * Trava de EXECUÇÃO ÚNICA da suíte — advisory lock do próprio Postgres.
 *
 * `maxWorkers: 1` serializa os specs DENTRO de uma execução, mas não enxerga
 * uma segunda execução (outro terminal, outro agente, um job de CI): são
 * processos diferentes, os dois falando com o MESMO banco de dev, e a corrida
 * sobre a linha `padraoSistema` volta inteira. Não é hipótese — em 21/08/2026
 * duas sessões rodando a suíte ao mesmo tempo contaminaram uma a medição da
 * outra e quase levaram a conclusão errada sobre a taxa de falha.
 *
 * O advisory lock fecha exatamente esse buraco, com a propriedade que lock em
 * arquivo não tem: **morre COM a conexão**. Processo morto (Ctrl-C,
 * `taskkill /F`, queda) → o Postgres encerra a sessão e solta a trava sozinho.
 * Não existe lock órfão para limpar — verificado matando o processo à força e
 * sondando em seguida (`trava-suite.spec.ts` repete essa prova a cada
 * execução).
 *
 * ⚠️ A trava só funciona se o cliente que a pegou usar `connection_limit=1`
 * (quem monta é o `jest-global-setup.ts`): advisory lock pertence à CONEXÃO, e
 * com pool de N ele ficaria preso a uma conexão qualquer que o pool pode
 * reciclar.
 */

/**
 * Par `(classid, objid)` do lock: `(0, CHAVE_TRAVA_SUITE)`, sempre na forma de
 * DOIS inteiros — a forma de um bigint só usa outro espaço de chave
 * (`objsubid` diferente) e NÃO conflita com esta. Número arbitrário e fixo;
 * só precisa ser o mesmo em todo lugar que fala desta trava.
 */
export const CHAVE_TRAVA_SUITE = 728_461;

/**
 * Quanto a segunda execução espera antes de desistir. Uma suíte completa leva
 * ~10 s, então o caso comum — duas invocações quase juntas — se resolve
 * sozinho: a segunda espera a primeira acabar e segue. Só algo realmente preso
 * chega ao erro, e aí falhar explicando é melhor que pendurar para sempre.
 */
const ESPERA_TOTAL_MS = 30_000;
const INTERVALO_MS = 500;

/** Onde o globalSetup pendura o cliente da trava para o globalTeardown. */
export type GlobalComTrava = typeof globalThis & {
  __clienteTravaSuite?: PrismaClient;
};

/**
 * Pega a trava, esperando a vez se outra execução estiver rodando. Se a espera
 * esgotar, lança com o diagnóstico de quem segura — o jest aborta na hora com
 * essa mensagem, em vez de deixar a corrida aparecer como vermelho aleatório
 * num spec qualquer.
 */
export async function adquirirTravaSuite(prisma: PrismaClient): Promise<void> {
  const fim = Date.now() + ESPERA_TOTAL_MS;
  let avisou = false;
  for (;;) {
    const r = await prisma.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_lock(0, ${CHAVE_TRAVA_SUITE}::int) AS ok
    `;
    if (r[0]?.ok) return;
    if (!avisou) {
      console.warn(
        '[jest] Outra execução da suíte está usando este banco — aguardando a vez ' +
          `(até ${ESPERA_TOTAL_MS / 1000} s)…`,
      );
      avisou = true;
    }
    if (Date.now() >= fim) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVALO_MS));
  }
  throw new Error(await mensagemDeOcupado(prisma));
}

/**
 * Solta a trava no fim da execução. Redundante de propósito com o
 * `$disconnect` do teardown (que também solta) — explícito é mais fácil de
 * raciocinar, e o custo é uma query.
 */
export async function liberarTravaSuite(prisma: PrismaClient): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ ok: boolean }>>`
    SELECT pg_advisory_unlock(0, ${CHAVE_TRAVA_SUITE}::int) AS ok
  `;
  // false = esta conexão NÃO segurava a trava: o pool reciclou a conexão no
  // meio e a proteção foi perdida sem ninguém ver. O teardown transforma isso
  // em aviso — é o único sinal barato que existe.
  return r[0]?.ok ?? false;
}

/** Diagnóstico de quem está segurando — para a falha explicar, não acusar. */
async function mensagemDeOcupado(prisma: PrismaClient): Promise<string> {
  let dono = '';
  try {
    const linhas = await prisma.$queryRaw<
      Array<{ pid: number; backend_start: string }>
    >`
      SELECT a.pid, a.backend_start::text
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.classid = 0 AND l.objid = ${CHAVE_TRAVA_SUITE}::oid
        -- objsubid separa a forma (int,int) da forma bigint; database separa
        -- este banco dos vizinhos do cluster. Sem os dois filtros a mensagem
        -- podia acusar um pid INOCENTE (reproduzido em revisão: um lock
        -- bigint de mesmo número e um lock de outro database casavam aqui).
        AND l.objsubid = 2
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    if (linhas[0]) {
      dono = ` Quem segura: conexão pid ${linhas[0].pid} no Postgres (aberta em ${linhas[0].backend_start}).`;
    }
  } catch {
    // Sem diagnóstico extra — a mensagem principal já diz o que fazer.
  }
  return (
    'Outra execução da suíte está rodando neste banco e não terminou dentro ' +
    `de ${ESPERA_TOTAL_MS / 1000} s de espera.${dono} Rode uma por vez — a trava ` +
    'solta sozinha assim que o outro processo terminar ou morrer.'
  );
}
