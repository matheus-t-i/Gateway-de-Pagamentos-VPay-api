import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  PERMISSOES,
  SITUACAO_CHAVE_PIX,
  SITUACAO_USUARIO,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { JwtAuthGuard, type UsuarioAutenticado } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';

type Req = { user: UsuarioAutenticado };

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
@Controller('painel/chaves-pix')
@UseGuards(JwtAuthGuard)
export class ChavesPixController {
  constructor(private readonly prisma: PrismaService) {}

  private async conta(user: Req['user']) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(user.id) },
    });
    if (!usuario) throw new NotFoundException('Conta não encontrada');
    return usuario;
  }

  @Get()
  @RequerPermissao(PERMISSOES.CHAVES_PIX_VER)
  async listar(@Req() req: Req) {
    const rows = await this.prisma.chavePixUsuario.findMany({
      where: {
        usuarioId: BigInt(req.user.id),
        situacao: { not: SITUACAO_CHAVE_PIX.INATIVA },
      },
      orderBy: { criadoEm: 'desc' },
    });
    return rows.map(mapChave);
  }

  @Post()
  @RequerPermissao(PERMISSOES.CHAVES_PIX_CRIAR)
  async criar(@Body() body: unknown, @Req() req: Req) {
    const parsed = criarChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const usuario = await this.conta(req.user);
    if (usuario.situacao !== SITUACAO_USUARIO.ATIVO) {
      throw new BadRequestException('Conta não está ativa.');
    }

    const criada = await this.prisma.chavePixUsuario.create({
      data: {
        usuarioId: usuario.id,
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
  @RequerPermissao(PERMISSOES.CHAVES_PIX_EXCLUIR)
  async remover(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Req() req: Req,
  ) {
    const r = await this.prisma.chavePixUsuario.updateMany({
      where: {
        idPublico: chaveIdPublico,
        usuarioId: BigInt(req.user.id),
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

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_VER)
  async listar(@Query('situacao') situacao: string | undefined) {
    const validas: string[] = [
      SITUACAO_CHAVE_PIX.PENDENTE,
      SITUACAO_CHAVE_PIX.APROVADA,
      SITUACAO_CHAVE_PIX.REPROVADA,
      SITUACAO_CHAVE_PIX.INATIVA,
    ];
    if (situacao && !validas.includes(situacao)) {
      throw new BadRequestException('situacao inválida');
    }
    const rows = await this.prisma.chavePixUsuario.findMany({
      where: { situacao: (situacao as never) ?? SITUACAO_CHAVE_PIX.PENDENTE },
      orderBy: { criadoEm: 'asc' },
      take: 200,
      include: {
        usuario: {
          select: {
            idPublico: true,
            nomeRazaoSocial: true,
            cpfCnpj: true,
            situacao: true,
          },
        },
      },
    });
    return rows.map((c) => ({
      ...mapChave(c),
      cliente: {
        idPublico: c.usuario.idPublico,
        nome: c.usuario.nomeRazaoSocial,
        cpfCnpj: c.usuario.cpfCnpj,
        situacao: c.usuario.situacao,
      },
    }));
  }

  @Post(':chaveIdPublico/decidir')
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_APROVAR)
  async decidir(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    const parsed = decidirChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const chave = await this.prisma.chavePixUsuario.findUnique({
      where: { idPublico: chaveIdPublico },
      include: { usuario: { select: { email: true, nomeRazaoSocial: true } } },
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
      const c = await tx.chavePixUsuario.update({
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
          usuarioAfetadoId: chave.usuarioId,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: `CHAVE_PIX_${parsed.data.situacao}`,
          nomeTabela: 'chaves_pix_usuarios',
          chaveRegistro: chave.id.toString(),
        },
      });
      return c;
    });

    // O cliente precisa saber: sem chave aprovada ele não consegue sacar.
    await this.queues.enqueueEmail({
      tipo:
        parsed.data.situacao === SITUACAO_CHAVE_PIX.APROVADA
          ? TIPOS_EMAIL.CHAVE_PIX_APROVADA
          : TIPOS_EMAIL.CHAVE_PIX_REPROVADA,
      para: chave.usuario.email,
      nome: chave.usuario.nomeRazaoSocial,
      dados: {
        chave: chave.chave,
        ...(parsed.data.motivo ? { motivo: parsed.data.motivo } : {}),
      },
    });

    return mapChave(atualizada);
  }
}
