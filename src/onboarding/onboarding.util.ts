import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  documentosObrigatoriosEmpresa,
  DOCUMENTOS_OBRIGATORIOS_USUARIO,
  SITUACAO_ANALISE,
  SITUACAO_DOCUMENTO,
  SITUACAO_EMPRESA,
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
  /** PF: documentos do titular. PJ: documentos do responsável. */
  tipoPessoa: 'PF' | 'PJ';
  documentosUsuario: DocsStatus;
  empresa: {
    idPublico: string;
    situacao: string;
    tipoPessoa: 'PF' | 'PJ';
    /** false para PF — a empresa é a própria pessoa e não exige documentação. */
    exigeDocumentos: boolean;
    documentos: DocsStatus;
  } | null;
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
 * Monta o retrato de onboarding de um usuário: situação da conta, documentos do
 * titular e da primeira empresa (proprietário). Reusado pelo login e pelo
 * endpoint público /onboarding/status.
 */
export async function montarStatusOnboarding(
  prisma: PrismaService,
  usuarioId: bigint,
): Promise<StatusOnboarding> {
  const usuario = await prisma.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    include: {
      documentos: { orderBy: { enviadoEm: 'desc' } },
      empresasProprietario: {
        orderBy: { criadoEm: 'asc' },
        include: { documentos: { orderBy: { enviadoEm: 'desc' } } },
      },
    },
  });

  const empresa = usuario.empresasProprietario[0] ?? null;
  const obrigatoriosEmpresa = empresa
    ? documentosObrigatoriosEmpresa(empresa.tipoPessoa)
    : [];

  return {
    situacao: usuario.situacao,
    tipoPessoa: usuario.tipoPessoa,
    documentosUsuario: mapDocs(
      DOCUMENTOS_OBRIGATORIOS_USUARIO,
      usuario.documentos as DocRow[],
    ),
    empresa: empresa
      ? {
          idPublico: empresa.idPublico,
          situacao: empresa.situacao,
          tipoPessoa: empresa.tipoPessoa,
          exigeDocumentos: obrigatoriosEmpresa.length > 0,
          documentos: mapDocs(obrigatoriosEmpresa, empresa.documentos as DocRow[]),
        }
      : null,
  };
}

/**
 * Reavalia a situação do usuário E de todas as suas empresas após qualquer
 * mudança de documentação (envio novo ou invalidação pelo analista).
 *
 * Bidirecional de propósito:
 *  - completou os obrigatórios → PENDENTE vira EM_ANALISE;
 *  - analista invalidou um obrigatório → EM_ANALISE volta para PENDENTE, senão
 *    a conta seguiria na fila de aprovação sem a documentação exigida.
 *
 * A empresa de PF não exige documento algum, por isso ela acompanha a
 * documentação pessoal — do contrário ficaria PENDENTE para sempre.
 */
export async function reavaliarSituacoes(
  tx: Prisma.TransactionClient,
  usuarioId: bigint,
) {
  const usuario = await tx.usuario.findUniqueOrThrow({
    where: { id: usuarioId },
    include: {
      documentos: true,
      empresasProprietario: { include: { documentos: true } },
    },
  });

  const pessoaisFaltando = documentosFaltantes(
    DOCUMENTOS_OBRIGATORIOS_USUARIO,
    usuario.documentos,
  );
  const donoAtivo = usuario.situacao === SITUACAO_USUARIO.ATIVO;

  if (usuario.situacao === SITUACAO_USUARIO.PENDENTE && pessoaisFaltando.length === 0) {
    await mudarSituacaoUsuario(
      tx,
      usuarioId,
      SITUACAO_USUARIO.PENDENTE,
      SITUACAO_USUARIO.EM_ANALISE,
      'Documentação enviada',
    );
  } else if (
    usuario.situacao === SITUACAO_USUARIO.EM_ANALISE &&
    pessoaisFaltando.length > 0
  ) {
    await mudarSituacaoUsuario(
      tx,
      usuarioId,
      SITUACAO_USUARIO.EM_ANALISE,
      SITUACAO_USUARIO.PENDENTE,
      `Documento invalidado — reenviar: ${pessoaisFaltando.join(', ')}`,
    );
  }

  for (const empresa of usuario.empresasProprietario) {
    const faltam = documentosFaltantes(
      documentosObrigatoriosEmpresa(empresa.tipoPessoa),
      empresa.documentos,
    );
    // Onboarding inicial: a empresa só avança junto da documentação pessoal.
    // Para dono já ATIVO (empresa adicional), a pessoal já foi aprovada.
    const pessoalOk = donoAtivo || pessoaisFaltando.length === 0;

    if (
      empresa.situacao === SITUACAO_EMPRESA.PENDENTE &&
      faltam.length === 0 &&
      pessoalOk
    ) {
      await mudarSituacaoEmpresa(
        tx,
        empresa.id,
        SITUACAO_EMPRESA.PENDENTE,
        SITUACAO_EMPRESA.EM_ANALISE,
        empresa.tipoPessoa === 'PJ'
          ? 'Documentação enviada'
          : 'Documentação pessoal enviada (empresa PF não exige documentos)',
      );
    } else if (empresa.situacao === SITUACAO_EMPRESA.EM_ANALISE && faltam.length > 0) {
      await mudarSituacaoEmpresa(
        tx,
        empresa.id,
        SITUACAO_EMPRESA.EM_ANALISE,
        SITUACAO_EMPRESA.PENDENTE,
        `Documento invalidado — reenviar: ${faltam.join(', ')}`,
      );
    }
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

async function mudarSituacaoEmpresa(
  tx: Prisma.TransactionClient,
  empresaId: bigint,
  de: string,
  para: 'PENDENTE' | 'EM_ANALISE',
  motivo: string,
) {
  await tx.empresa.update({ where: { id: empresaId }, data: { situacao: para } });
  await tx.analiseCadastroEmpresa.updateMany({
    where: {
      empresaId,
      situacao: { in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE] },
    },
    data: {
      situacao:
        para === SITUACAO_EMPRESA.EM_ANALISE
          ? SITUACAO_ANALISE.EM_ANALISE
          : SITUACAO_ANALISE.PENDENTE,
    },
  });
  await tx.historicoSituacaoEmpresa.create({
    data: { empresaId, situacaoAnterior: de, novaSituacao: para, motivo },
  });
}
