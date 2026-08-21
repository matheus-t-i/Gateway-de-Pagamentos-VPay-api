/**
 * Processo-filho do `trava-suite.spec.ts`: pega um advisory lock e fica vivo
 * até ser MORTO — faz o papel de "outra execução da suíte" no teste, que o
 * derruba com kill à força para provar que a trava não deixa órfão.
 *
 * Recebe a chave por argv para nunca disputar a chave REAL com a suíte que o
 * está rodando (ela mesma segura a real, via globalSetup).
 *
 * JavaScript puro de propósito: é spawnado com `node` direto, sem transform.
 * `DATABASE_URL` vem herdada do processo pai.
 */
const chave = Number(process.argv[2]);
if (!Number.isInteger(chave)) {
  console.error('uso: node segurador-trava.js <chave-inteira>');
  process.exit(2);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const r = await prisma.$queryRawUnsafe(
    `SELECT pg_try_advisory_lock(0, ${chave}) AS ok`,
  );
  if (!r[0] || !r[0].ok) {
    console.error(`chave (0, ${chave}) ja esta ocupada`);
    process.exit(3);
  }
  // O pai espera esta linha no stdout para saber que a trava está de pé.
  console.log('TRAVADO');
  // Vivo e ocioso até o kill — segurar a conexão é o trabalho todo.
  setInterval(() => {}, 2147483647);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
