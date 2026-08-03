import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  criarChavePixSchema,
  decidirChavePixSchema,
  PAPEIS,
  SITUACAO_CHAVE_PIX,
  SITUACAO_EMPRESA,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

type Req = { user: { id: string; papeis: string[] } };

function mapChave(c: {
  idPublico: string;
  apelido: string | null;
  chave: string;
  tipoChave: string;
  nomeTitular: string | null;
  situacao: string;
  motivoReprovacao: string | null;
  aprovadaEm: Date | null;
  criadoEm: Date;
}) {
  return {
    idPublico: c.idPublico,
    apelido: c.apelido,
    chave: c.chave,
    tipoChave: c.tipoChave,
    nomeTitular: c.nomeTitular,
    situacao: c.situacao,
    motivoReprovacao: c.motivoReprovacao,
    aprovadaEm: c.aprovadaEm,
    criadoEm: c.criadoEm,
  };
}

/**
 * Chaves PIX de saque do cliente. O cliente cadastra; o saque pelo painel só é
 * liberado depois que um ADMINISTRADOR aprova a chave.
 */
@Controller('painel/empresas/:empresaIdPublico/chaves-pix')
@UseGuards(JwtAuthGuard)
export class ChavesPixController {
  constructor(private readonly prisma: PrismaService) {}

  private async getEmpresa(idPublico: string, user: Req['user']) {
    const empresa = await this.prisma.empresa.findUnique({ where: { idPublico } });
    if (!empresa) throw new NotFoundException('Empresa não encontrada');
    const isAdmin = user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== user.id) {
      throw new ForbiddenException('Sem acesso a esta empresa');
    }
    return empresa;
  }

  @Get()
  async listar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Req() req: Req,
  ) {
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    const rows = await this.prisma.chavePixEmpresa.findMany({
      where: { empresaId: empresa.id, situacao: { not: SITUACAO_CHAVE_PIX.INATIVA } },
      orderBy: { criadoEm: 'desc' },
    });
    return rows.map(mapChave);
  }

  @Post()
  async criar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    const parsed = criarChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    if (empresa.situacao !== SITUACAO_EMPRESA.ATIVA) {
      throw new BadRequestException('Empresa não está ativa.');
    }

    const criada = await this.prisma.chavePixEmpresa.create({
      data: {
        empresaId: empresa.id,
        apelido: parsed.data.apelido,
        chave: parsed.data.chave,
        tipoChave: parsed.data.tipoChave,
        nomeTitular: parsed.data.nomeTitular,
        documentoTitular: parsed.data.documentoTitular?.replace(/\D/g, ''),
        // Nasce PENDENTE: saque só é liberado após aprovação do administrador.
        situacao: SITUACAO_CHAVE_PIX.PENDENTE,
        criadoPorUsuarioId: BigInt(req.user.id),
      },
    });
    return mapChave(criada);
  }

  /** Remoção lógica — preserva o vínculo com saques já realizados. */
  @Delete(':chaveIdPublico')
  async remover(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Req() req: Req,
  ) {
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    const r = await this.prisma.chavePixEmpresa.updateMany({
      where: {
        idPublico: chaveIdPublico,
        empresaId: empresa.id,
        situacao: { not: SITUACAO_CHAVE_PIX.INATIVA },
      },
      data: { situacao: SITUACAO_CHAVE_PIX.INATIVA },
    });
    if (r.count === 0) throw new NotFoundException('Chave não encontrada');
    return { ok: true };
  }
}

/** Fila de aprovação de chaves PIX (gestor/administrador). */
@Controller('admin/chaves-pix')
@UseGuards(JwtAuthGuard)
export class AdminChavesPixController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  private assertAdmin(req: Req) {
    if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new ForbiddenException('Somente ADMINISTRADOR');
    }
  }

  @Get()
  async listar(@Query('situacao') situacao: string | undefined, @Req() req: Req) {
    this.assertAdmin(req);
    const validas: string[] = [
      SITUACAO_CHAVE_PIX.PENDENTE,
      SITUACAO_CHAVE_PIX.APROVADA,
      SITUACAO_CHAVE_PIX.REPROVADA,
      SITUACAO_CHAVE_PIX.INATIVA,
    ];
    if (situacao && !validas.includes(situacao)) {
      throw new BadRequestException('situacao inválida');
    }
    const rows = await this.prisma.chavePixEmpresa.findMany({
      where: { situacao: (situacao as never) ?? SITUACAO_CHAVE_PIX.PENDENTE },
      orderBy: { criadoEm: 'asc' },
      take: 200,
      include: {
        empresa: {
          select: { idPublico: true, razaoSocial: true, cnpj: true, situacao: true },
        },
      },
    });
    return rows.map((c) => ({ ...mapChave(c), empresa: c.empresa }));
  }

  @Post(':chaveIdPublico/decidir')
  async decidir(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    this.assertAdmin(req);
    const parsed = decidirChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const chave = await this.prisma.chavePixEmpresa.findUnique({
      where: { idPublico: chaveIdPublico },
    });
    if (!chave) throw new NotFoundException('Chave não encontrada');
    if (chave.situacao !== SITUACAO_CHAVE_PIX.PENDENTE) {
      throw new BadRequestException(
        `Chave já analisada (situação atual: ${chave.situacao}).`,
      );
    }
    if (parsed.data.situacao === SITUACAO_CHAVE_PIX.REPROVADA && !parsed.data.motivo) {
      throw new BadRequestException('Informe o motivo da reprovação.');
    }

    const atualizada = await this.prisma.$transaction(async (tx) => {
      const c = await tx.chavePixEmpresa.update({
        where: { id: chave.id },
        data: {
          situacao: parsed.data.situacao,
          motivoReprovacao:
            parsed.data.situacao === SITUACAO_CHAVE_PIX.REPROVADA
              ? parsed.data.motivo
              : null,
          aprovadaPorUsuarioId: BigInt(req.user.id),
          aprovadaEm: new Date(),
        },
      });
      await tx.registroAuditoria.create({
        data: {
          empresaAfetadaId: chave.empresaId,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: `CHAVE_PIX_${parsed.data.situacao}`,
          nomeTabela: 'chaves_pix_empresas',
          chaveRegistro: chave.id.toString(),
        },
      });
      return c;
    });

    // O cliente precisa saber: sem chave aprovada ele não consegue sacar.
    const dono = await this.prisma.empresa.findUnique({
      where: { id: chave.empresaId },
      include: { usuarioProprietario: { select: { email: true, nomeRazaoSocial: true } } },
    });
    if (dono) {
      await this.queues.enqueueEmail({
        tipo:
          parsed.data.situacao === SITUACAO_CHAVE_PIX.APROVADA
            ? TIPOS_EMAIL.CHAVE_PIX_APROVADA
            : TIPOS_EMAIL.CHAVE_PIX_REPROVADA,
        para: dono.usuarioProprietario.email,
        nome: dono.usuarioProprietario.nomeRazaoSocial,
        dados: {
          chave: chave.chave,
          ...(parsed.data.motivo ? { motivo: parsed.data.motivo } : {}),
        },
      });
    }

    return mapChave(atualizada);
  }
}
