import { liberarTravaSuite, type GlobalComTrava } from './trava-suite';

/**
 * Contraparte do `jest-global-setup.ts`: solta a trava de execução única e
 * fecha a conexão que a segurava.
 *
 * Se o processo morrer antes de chegar aqui, tudo bem — advisory lock morre
 * com a conexão, e foi exatamente por isso que ele foi escolhido: não existe
 * lock órfão para uma execução futura limpar.
 */
export default async function globalTeardown(): Promise<void> {
  const prisma = (globalThis as GlobalComTrava).__clienteTravaSuite;
  if (!prisma) return;
  try {
    const soltou = await liberarTravaSuite(prisma);
    if (!soltou) avisarTravaPerdida('o Postgres respondeu que esta conexão não segurava a trava');
  } catch (erro) {
    /**
     * Erro aqui (tipicamente P1017, conexão fechada pelo servidor) significa
     * que a conexão da trava MORREU NO MEIO da suíte — restart do Postgres,
     * idle timeout, blip. A partir daquele instante a execução rodou SEM
     * proteção e outra suíte pode ter entrado junto. Engolir isso em
     * silêncio seria terminar verde fingindo proteção que não houve.
     */
    avisarTravaPerdida(erro instanceof Error ? erro.message : String(erro));
  }
  await prisma.$disconnect().catch(() => undefined);
  delete (globalThis as GlobalComTrava).__clienteTravaSuite;
}

function avisarTravaPerdida(causa: string): void {
  console.warn(
    '[jest] ⚠️ A conexão que segurava a trava de execução única MORREU no meio ' +
      'da suíte — a partir desse ponto outra execução pode ter rodado junto e o ' +
      'resultado pode estar contaminado. Se houve vermelho estranho, rode de ' +
      `novo. Causa: ${causa}`,
  );
}
