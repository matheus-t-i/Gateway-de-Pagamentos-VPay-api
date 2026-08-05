import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  documentosObrigatorios,
  SITUACAO_ANALISE,
  SITUACAO_DOCUMENTO,
  SITUACAO_USUARIO,
} from '../shared';

type DocRow = {
  id: bigint;
  tipoDocumento: string;
  situacao: string;
  nomeArquivo: string;
  enviadoEm: Date;
  motivoInvalidacao: string | null;
};

export type DocsStatus = {
  enviados: Array<{
    tipoDocumento: string;
    situacao: string;
    nomeArquivo: string;
    enviadoEm: string;
    motivoInvalidacao: string | null;
  }>;
  faltantes: string[];
};

export type StatusOnboarding = {
  situacao: string;
  /** PF: documentos do titular. PJ: do responsável + os da pessoa jurídica. */
  tipoPessoa: 'PF' | 'PJ';
  documentos: DocsStatus;
};

/**
 * Um tipo obrigatório é considerado satisfeito quando existe pelo menos um
 * documento daquele tipo com situação PENDENTE ou VALIDO. Documentos INVALIDO
 * (reprovados pelo admin) voltam a contar como faltantes — exigem reenvio.
 */
export function documentosFaltantes(
  obrigatorios: string[],
  docs: Array<{ tipoDocumento: string; situacao: string }>,
): string[] {
  const satisfeitos = new Set(
    docs
      .filter(
        (d) =>
          d.situacao === SITUACAO_DOCUMENTO.PENDENTE ||
          d.situacao === SITUACAO_DOCUMENTO.VALIDO,
      )
      .map((d) => d.tipoDocumento),
  );
  return obrigatorios.filter((tipo) => !satisfeitos.has(tipo));
}

/**
 * Serialização de documento para as telas de admin (aprovações e ficha do
 * cliente). `id` vira string porque BigInt não passa pelo JSON do Nest, e
 * `caminhoArquivo`/`hashArquivo` ficam de fora de propósito: o arquivo só sai
 * pelo endpoint de download autenticado.
 */
export function mapDocumentoAdmin(d: {
  id: bigint;
  tipoDocumento: string;
  nomeArquivo: string;
  tipoMime: string | null;
  tamanhoBytes: bigint | null;
  situacao: string;
  motivoInvalidacao: string | null;
  enviadoEm: Date;
  validadoEm: Date | null;
}) {
  return {
    id: d.id.toString(),
    tipoDocumento: d.tipoDocumento,
    nomeArquivo: d.nomeArquivo,
    tipoMime: d.tipoMime,
    tamanhoBytes: d.tamanhoBytes ? Number(d.tamanhoBytes) : null,
    situacao: d.situacao,
    motivoInvalidacao: d.motivoInvalidacao,
    enviadoEm: d.enviadoEm.toISOString(),
    validadoEm: d.validadoEm ? d.validadoEm.toISOString() : null,
  };
}

function mapDocs(obrigatorios: string[], docs: DocRow[]): DocsStatus {
  return {
    enviados: docs.map((d) => ({
      tipoDocumento: d.tipoDocumento,
      situacao: d.situacao,
      nomeArquivo: d.nomeArquivo,
      enviadoEm: d.enviadoEm.toISOString(),
      motivoInvalidacao: d.motivoInvalidacao,
    })),
    faltantes: documentosFaltantes(obrigatorios, docs),
  };
}

/**
 * Retrato de onboarding da conta: situação e documentação. Reusado pelo login e
 * pelo endpoint público /onboarding/status.
 */
export async function montarStatusOnboarding(
  prisma: PrismaService,
  usuarioId: bigint,
): Promise<StatusOnboarding> {
  const usuario = await prisma.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    include: { documentos: { orderBy: { enviadoEm: 'desc' } } },
  });

  return {
    situacao: usuario.situacao,
    tipoPessoa: usuario.tipoPessoa,
    documentos: mapDocs(
      documentosObrigatorios(usuario.tipoPessoa),
      usuario.documentos as DocRow[],
    ),
  };
}

/**
 * Reavalia a situação da conta após qualquer mudança de documentação (envio
 * novo ou invalidação pelo analista).
 *
 * Bidirecional de propósito:
 *  - completou os obrigatórios → PENDENTE vira EM_ANALISE;
 *  - analista invalidou um obrigatório → EM_ANALISE volta para PENDENTE, senão
 *    a conta seguiria na fila de aprovação sem a documentação exigida.
 */
export async function reavaliarSituacoes(
  tx: Prisma.TransactionClient,
  usuarioId: bigint,
) {
  const usuario = await tx.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    include: { documentos: true },
  });

  const faltando = documentosFaltantes(
    documentosObrigatorios(usuario.tipoPessoa),
    usuario.documentos,
  );

  if (usuario.situacao === SITUACAO_USUARIO.PENDENTE && faltando.length === 0) {
    await mudarSituacaoUsuario(
      tx,
      usuarioId,
      SITUACAO_USUARIO.PENDENTE,
      SITUACAO_USUARIO.EM_ANALISE,
      'Documentação enviada',
    );
  } else if (
    usuario.situacao === SITUACAO_USUARIO.EM_ANALISE &&
    faltando.length > 0
  ) {
    await mudarSituacaoUsuario(
      tx,
      usuarioId,
      SITUACAO_USUARIO.EM_ANALISE,
      SITUACAO_USUARIO.PENDENTE,
      `Documento invalidado — reenviar: ${faltando.join(', ')}`,
    );
  }
}

async function mudarSituacaoUsuario(
  tx: Prisma.TransactionClient,
  usuarioId: bigint,
  de: string,
  para: 'PENDENTE' | 'EM_ANALISE',
  motivo: string,
) {
  await tx.usuario.update({ where: { id: usuarioId }, data: { situacao: para } });
  await tx.analiseCadastroUsuario.updateMany({
    where: {
      usuarioId,
      situacao: { in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE] },
    },
    data: {
      situacao:
        para === SITUACAO_USUARIO.EM_ANALISE
          ? SITUACAO_ANALISE.EM_ANALISE
          : SITUACAO_ANALISE.PENDENTE,
    },
  });
  await tx.historicoSituacaoUsuario.create({
    data: { usuarioId, situacaoAnterior: de, novaSituacao: para, motivo },
  });
}
