/**
 * Esconder e devolver a linha `padraoSistema` — só para testes.
 *
 * `config-padrao.spec.ts` precisa testar o que acontece numa instalação SEM a
 * linha `padraoSistema` de `configuracoes_padrao_pix_usuarios` (instalação nova
 * não roda seed). Como os specs de banco rodam contra o Postgres de
 * DESENVOLVIMENTO, onde a linha existe, o jeito de simular a ausência é
 * escondê-la: `padraoSistema: false` + um nome que o `upsert` do PUT (que
 * procura por `nome: 'Padrao Sistema'`) não encontre.
 *
 * O perigo mora no "devolver". O `finally` do spec devolve — mas `finally` não
 * roda quando o processo MORRE no meio (Ctrl-C, kill por timeout). Aí o banco
 * de dev fica com a linha escondida e:
 *
 * - toda execução seguinte da suíte falha, em specs que não têm nada a ver;
 * - o próprio painel para de ativar conta, com "Defina o Padrão de novos
 *   clientes em Usuários antes de ativar a primeira conta" — mensagem de
 *   produto, que ninguém liga a um teste interrompido dias antes.
 *
 * Por isso o nome escondido CARREGA o original (`__spec_oculto__<nome>`): o
 * estado é reconhecível e reversível sem adivinhação. `restaurarPadraoOculto`
 * roda no `globalSetup` do jest, antes de qualquer spec, e desfaz sozinho.
 */

/** VarChar(120) em `configuracoes_padrao_pix_usuarios.nome`. */
const LIMITE_NOME = 120;

export const PREFIXO_OCULTO = '__spec_oculto__';

/**
 * Nome temporário que guarda o original. Recusa em vez de truncar: nome
 * truncado é nome perdido, e aí a restauração automática viraria chute.
 */
export function nomeOculto(original: string): string {
  const oculto = `${PREFIXO_OCULTO}${original}`;
  if (oculto.length > LIMITE_NOME) {
    throw new Error(
      `Nome "${original}" longo demais para esconder de forma reversível ` +
        `(${oculto.length} > ${LIMITE_NOME} caracteres).`,
    );
  }
  return oculto;
}

/** Cliente mínimo que a restauração usa — evita depender do PrismaService. */
type ClientePadrao = {
  configuracaoPadraoPixUsuario: {
    findMany: (args: {
      where: { nome: { startsWith: string } };
    }) => Promise<Array<{ id: bigint; nome: string }>>;
    deleteMany: (args: {
      where: { nome: string; id: { not: bigint } };
    }) => Promise<unknown>;
    update: (args: {
      where: { id: bigint };
      data: { padraoSistema: boolean; nome: string };
    }) => Promise<unknown>;
  };
};

/**
 * Devolve ao normal qualquer linha deixada escondida por uma execução
 * interrompida. Devolve quantas restaurou (0 = banco já estava são, que é o
 * caminho de sempre e não imprime nada).
 */
export async function restaurarPadraoOculto(
  prisma: ClientePadrao,
): Promise<number> {
  const ocultas = await prisma.configuracaoPadraoPixUsuario.findMany({
    where: { nome: { startsWith: PREFIXO_OCULTO } },
  });

  for (const oculta of ocultas) {
    const original = oculta.nome.slice(PREFIXO_OCULTO.length);
    /**
     * Enquanto a original estava escondida, o PUT do spec pode ter criado uma
     * linha nova COM O NOME DELA — e `nome` é unique, então essa sobra precisa
     * sair antes de o nome voltar.
     */
    try {
      await prisma.configuracaoPadraoPixUsuario.deleteMany({
        where: { nome: original, id: { not: oculta.id } },
      });
    } catch (erro) {
      throw new Error(
        `Não consegui restaurar a linha "${original}" de ` +
          'configuracoes_padrao_pix_usuarios: a linha temporária deixada por ' +
          'uma execução interrompida já está referenciada por alguma conta. ' +
          'Resolva à mão antes de rodar a suíte. ' +
          `Causa: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    }
    await prisma.configuracaoPadraoPixUsuario.update({
      where: { id: oculta.id },
      data: { padraoSistema: true, nome: original },
    });
  }

  return ocultas.length;
}
