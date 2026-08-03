import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  criarEmpresaSchema,
  documentosObrigatoriosEmpresa,
  PAPEIS,
  reprovarCadastroSchema,
  SITUACAO_ANALISE,
  SITUACAO_DOCUMENTO,
  SITUACAO_EMPRESA,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { salvarArquivo } from '../common/storage.util';
import { reavaliarSituacoes } from '../onboarding/onboarding.util';

@Controller('empresas')
@UseGuards(JwtAuthGuard)
export class EmpresasController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listar(@Req() req: { user: { id: string; papeis: string[] } }) {
    // "Minhas empresas" é sempre só as do próprio dono — inclusive para o
    // administrador. A visão cross-empresa do admin é pelos relatórios, não
    // por este endpoint (evita carregar TODAS as empresas a cada request).
    const empresas = await this.prisma.empresa.findMany({
      where: { usuarioProprietarioId: BigInt(req.user.id) },
      orderBy: { criadoEm: 'desc' },
      select: {
        idPublico: true,
        cnpj: true,
        razaoSocial: true,
        nomeFantasia: true,
        situacao: true,
        criadoEm: true,
        saldo: {
          select: {
            saldoDisponivel: true,
            saldoPendenteLiberacao: true,
            saldoReservado: true,
            saldoBloqueadoMed: true,
          },
        },
      },
    });
    return empresas.map((e) => ({
      ...e,
      saldo: e.saldo
        ? {
            disponivel: e.saldo.saldoDisponivel.toString(),
            pendenteLiberacao: e.saldo.saldoPendenteLiberacao.toString(),
            reservado: e.saldo.saldoReservado.toString(),
            bloqueadoMed: e.saldo.saldoBloqueadoMed.toString(),
          }
        : null,
    }));
  }

  @Post()
  async criar(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const parsed = criarEmpresaSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const data = parsed.data;
    const exists = await this.prisma.empresa.findUnique({ where: { cnpj: data.cnpj } });
    if (exists) throw new BadRequestException('CNPJ já cadastrado');

    const empresa = await this.prisma.empresa.create({
      data: {
        usuarioProprietarioId: BigInt(req.user.id),
        cnpj: data.cnpj,
        // Empresa adicional é sempre PJ (a 1ª, que pode ser PF, nasce no cadastro).
        tipoPessoa: 'PJ',
        razaoSocial: data.razaoSocial,
        nomeFantasia: data.nomeFantasia,
        email: data.email,
        telefone: data.telefone,
        situacao: SITUACAO_EMPRESA.PENDENTE,
        criadoPorUsuarioId: BigInt(req.user.id),
        analises: { create: { situacao: SITUACAO_ANALISE.PENDENTE } },
        historicosSituacao: {
          create: {
            novaSituacao: SITUACAO_EMPRESA.PENDENTE,
            motivo: 'Cadastro inicial',
            usuarioAtorId: BigInt(req.user.id),
          },
        },
      },
    });
    return {
      idPublico: empresa.idPublico,
      cnpj: empresa.cnpj,
      razaoSocial: empresa.razaoSocial,
      situacao: empresa.situacao,
    };
  }

  /**
   * Documentos de empresa ADICIONAL (criada por quem já está ATIVO).
   * O canal público de onboarding recusa conta ATIVA, então sem este endpoint a
   * empresa nova ficaria PENDENTE para sempre — nem o admin conseguia ativá-la.
   */
  @Post(':idPublico/documentos')
  @UseInterceptors(
    FileInterceptor('arquivo', {
      limits: { fileSize: 10 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = ['application/pdf', 'image/jpeg', 'image/png'].includes(
          file.mimetype,
        );
        cb(
          ok ? null : new BadRequestException(`Tipo não permitido: ${file.mimetype}`),
          ok,
        );
      },
    }),
  )
  async enviarDocumentoEmpresa(
    @Param('idPublico') idPublico: string,
    @Body() body: { tipoDocumento?: string },
    @Req() req: { user: { id: string; papeis: string[] } },
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    if (!arquivo) throw new BadRequestException('Arquivo ausente (campo "arquivo").');
    const tipoDocumento = body.tipoDocumento ?? '';
    if (!documentosObrigatoriosEmpresa('PJ').includes(tipoDocumento as never)) {
      throw new BadRequestException(`tipoDocumento inválido: ${tipoDocumento}`);
    }

    const empresa = await this.prisma.empresa.findUnique({ where: { idPublico } });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    if (empresa.situacao === SITUACAO_EMPRESA.ATIVA) {
      throw new BadRequestException('Empresa já está ativa.');
    }

    const salvo = await salvarArquivo('empresas', empresa.id, arquivo);
    await this.prisma.$transaction(async (tx) => {
      await tx.documentoEmpresa.create({
        data: {
          empresaId: empresa.id,
          tipoDocumento,
          nomeArquivo: salvo.nomeArquivo,
          caminhoArquivo: salvo.caminhoArquivo,
          tipoMime: salvo.tipoMime,
          tamanhoBytes: BigInt(salvo.tamanhoBytes),
          hashArquivo: salvo.hashArquivo,
          situacao: SITUACAO_DOCUMENTO.PENDENTE,
        },
      });
      await reavaliarSituacoes(tx, empresa.usuarioProprietarioId);
    });

    const atualizada = await this.prisma.empresa.findUniqueOrThrow({
      where: { id: empresa.id },
    });
    return { ok: true, situacao: atualizada.situacao };
  }

  @Get(':idPublico')
  async detalhe(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico },
      include: { saldo: true },
    });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    return {
      idPublico: empresa.idPublico,
      cnpj: empresa.cnpj,
      razaoSocial: empresa.razaoSocial,
      situacao: empresa.situacao,
      saldo: empresa.saldo
        ? {
            disponivel: empresa.saldo.saldoDisponivel.toString(),
            pendenteLiberacao: empresa.saldo.saldoPendenteLiberacao.toString(),
            reservado: empresa.saldo.saldoReservado.toString(),
            bloqueadoMed: empresa.saldo.saldoBloqueadoMed.toString(),
          }
        : null,
    };
  }
}

@Controller('admin/empresas')
@UseGuards(JwtAuthGuard)
export class AdminEmpresasController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(':idPublico/ativar')
  async ativar(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico },
      include: { documentos: true },
    });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');

    // Gate de aprovação: espelho do gate de usuário — exige documentação enviada
    // (EM_ANALISE) e nenhum obrigatório apenas com versão INVALIDO.
    if (empresa.situacao !== SITUACAO_EMPRESA.EM_ANALISE) {
      throw new BadRequestException(
        `Empresa não está em análise (situação atual: ${empresa.situacao}). ` +
          'A documentação precisa ser enviada antes da aprovação.',
      );
    }
    const obrigatoriosInvalidos = documentosObrigatoriosEmpresa(
      empresa.tipoPessoa,
    ).filter((tipo) =>
      empresa.documentos.some(
        (d) =>
          d.tipoDocumento === tipo && d.situacao === SITUACAO_DOCUMENTO.INVALIDO,
      ) &&
      !empresa.documentos.some(
        (d) =>
          d.tipoDocumento === tipo &&
          (d.situacao === SITUACAO_DOCUMENTO.VALIDO ||
            d.situacao === SITUACAO_DOCUMENTO.PENDENTE),
      ),
    );
    if (obrigatoriosInvalidos.length > 0) {
      throw new BadRequestException(
        `Documentos obrigatórios inválidos: ${obrigatoriosInvalidos.join(', ')}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.empresa.update({
        where: { id: empresa.id },
        data: {
          situacao: SITUACAO_EMPRESA.ATIVA,
          ativadaEm: new Date(),
          ativadaPorUsuarioId: BigInt(req.user.id),
        },
      });
      await tx.saldoEmpresa.upsert({
        where: { empresaId: empresa.id },
        create: { empresaId: empresa.id },
        update: {},
      });
      await tx.historicoSituacaoEmpresa.create({
        data: {
          empresaId: empresa.id,
          situacaoAnterior: empresa.situacao,
          novaSituacao: SITUACAO_EMPRESA.ATIVA,
          motivo: 'Ativação administrativa',
          usuarioAtorId: BigInt(req.user.id),
        },
      });
      await tx.analiseCadastroEmpresa.updateMany({
        where: {
          empresaId: empresa.id,
          situacao: { in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE] },
        },
        data: {
          situacao: SITUACAO_ANALISE.APROVADA,
          analisadoPorUsuarioId: BigInt(req.user.id),
          analisadoEm: new Date(),
        },
      });
      await tx.registroAuditoria.create({
        data: {
          empresaAfetadaId: empresa.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'EMPRESA_ATIVAR',
          nomeTabela: 'empresas',
          chaveRegistro: empresa.id.toString(),
        },
      });
    });

    return { ok: true, situacao: SITUACAO_EMPRESA.ATIVA };
  }

  @Post(':idPublico/reprovar')
  async reprovar(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
    const parsed = reprovarCadastroSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const empresa = await this.prisma.empresa.findUnique({ where: { idPublico } });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    if (empresa.situacao === SITUACAO_EMPRESA.ATIVA) {
      throw new BadRequestException('Empresa já ativa — use suspensão/bloqueio.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.empresa.update({
        where: { id: empresa.id },
        data: {
          situacao: SITUACAO_EMPRESA.REPROVADA,
          motivoReprovacao: parsed.data.motivo,
        },
      });
      await tx.historicoSituacaoEmpresa.create({
        data: {
          empresaId: empresa.id,
          situacaoAnterior: empresa.situacao,
          novaSituacao: SITUACAO_EMPRESA.REPROVADA,
          motivo: parsed.data.motivo,
          usuarioAtorId: BigInt(req.user.id),
        },
      });
      await tx.analiseCadastroEmpresa.updateMany({
        where: {
          empresaId: empresa.id,
          situacao: { in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE] },
        },
        data: {
          situacao: SITUACAO_ANALISE.REPROVADA,
          observacoes: parsed.data.motivo,
          analisadoPorUsuarioId: BigInt(req.user.id),
          analisadoEm: new Date(),
        },
      });
      await tx.registroAuditoria.create({
        data: {
          empresaAfetadaId: empresa.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'EMPRESA_REPROVAR',
          nomeTabela: 'empresas',
          chaveRegistro: empresa.id.toString(),
        },
      });
    });

    return { ok: true, situacao: SITUACAO_EMPRESA.REPROVADA };
  }
}
