import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, type UsuarioAutenticado } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import {
  DISPONIBILIDADE_ADQUIRENTE,
  escolherAdquirentePixEntradaSchema,
  PERMISSOES,
} from '../shared';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';
import { AdquirentesService } from './adquirentes.service';

/**
 * Vitrine do LOJISTA: as adquirentes que ele pode usar no PIX in e a escolha da
 * que fica em uso. Nunca devolve conta, credencial ou custo — só o que o
 * administrador decidiu expor (nome fantasia, MED e observação).
 */
@Controller('painel/adquirentes')
@UseGuards(JwtAuthGuard)
export class PainelAdquirentesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adquirentes: AdquirentesService,
  ) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADQUIRENTES_VER)
  async listar(@Req() req: { user: UsuarioAutenticado }) {
    return this.adquirentes.listarLiberadasPara(BigInt(req.user.id));
  }

  @Put('pix-entrada')
  @RequerPermissao(PERMISSOES.ADQUIRENTES_EDITAR)
  async escolherPixEntrada(
    @Req() req: { user: UsuarioAutenticado; ip?: string },
    @Body() body: unknown,
  ) {
    const parsed = escolherAdquirentePixEntradaSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const usuarioId = BigInt(req.user.id);

    const conta = await this.adquirentes.resolverContaPixEntrada(
      parsed.data.adquirenteCodigo,
    );
    if (!(await this.adquirentes.estaLiberada(usuarioId, conta.provedorPagamentoId))) {
      throw new BadRequestException(
        'Esta adquirente não está liberada para a sua conta.',
      );
    }

    const cfg = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId },
      include: { contaEntrada: { include: { provedor: true } } },
    });
    if (!cfg) {
      throw new BadRequestException(
        'Configuração PIX ainda não liberada para a sua conta.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.configuracaoPixUsuario.update({
        where: { usuarioId },
        data: {
          contaProvedorPixEntradaId: conta.id,
          adquirentePixEntradaTrocadaEm: new Date(),
          atualizadoPorUsuarioId: usuarioId,
        },
      }),
      this.prisma.registroAuditoria.create({
        data: {
          usuarioAfetadoId: usuarioId,
          usuarioAtorId: usuarioId,
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'ADQUIRENTE_ESCOLHER_PIX_ENTRADA',
          nomeTabela: 'configuracoes_pix_usuarios',
          chaveRegistro: usuarioId.toString(),
          enderecoIp: req.ip,
          dadosAnteriores: { adquirente: cfg.contaEntrada.provedor.codigo },
          dadosNovos: { adquirente: parsed.data.adquirenteCodigo },
        },
      }),
    ]);

    return { ok: true, adquirente: parsed.data.adquirenteCodigo };
  }
}

/**
 * Vitrine pelo lado do ADMINISTRADOR: quem está liberado em cada adquirente e o
 * preview de impacto que alimenta a troca forçada.
 */
@Controller('admin/adquirentes')
@UseGuards(JwtAuthGuard)
export class AdminAdquirentesVitrineController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adquirentes: AdquirentesService,
  ) {}

  /** Clientes liberados nominalmente nesta adquirente (paginado + busca). */
  @Get(':codigo/clientes')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_VER)
  async clientes(@Param('codigo') codigo: string, @Query() q: Record<string, string>) {
    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
    });
    if (!provedor) throw new BadRequestException('Adquirente não encontrada');

    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));
    const busca = (q.busca ?? '').trim();
    const documentoBusca = busca.replace(/[^0-9A-Za-z]/g, '');
    const where = {
      provedorPagamentoId: provedor.id,
      ...(busca
        ? {
            usuario: {
              OR: [
                { nomeRazaoSocial: { contains: busca, mode: 'insensitive' as const } },
                { email: { contains: busca, mode: 'insensitive' as const } },
                // `contains: ''` bate com qualquer registro no Prisma — só entra
                // na busca se sobrou algo depois de tirar a pontuação.
                ...(documentoBusca ? [{ cpfCnpj: { contains: documentoBusca } }] : []),
              ],
            },
          }
        : {}),
    };

    const [total, itens] = await Promise.all([
      this.prisma.liberacaoAdquirenteUsuario.count({ where }),
      this.prisma.liberacaoAdquirenteUsuario.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          usuario: {
            select: {
              idPublico: true,
              nomeRazaoSocial: true,
              email: true,
              cpfCnpj: true,
              situacao: true,
            },
          },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      disponibilidade: provedor.disponibilidadePixEntrada,
      itens: itens.map((l) => ({
        idPublico: l.usuario.idPublico,
        nome: l.usuario.nomeRazaoSocial,
        email: l.usuario.email,
        cpfCnpj: l.usuario.cpfCnpj,
        situacao: l.usuario.situacao,
        liberadoEm: l.criadoEm.toISOString(),
      })),
    };
  }

  @Post(':codigo/clientes')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async liberar(
    @Param('codigo') codigo: string,
    @Body() body: { usuarioIdPublico?: string; codigoTotp?: string },
    @Req() req: { user: { id: string } },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
    });
    if (!provedor) throw new BadRequestException('Adquirente não encontrada');
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico: body?.usuarioIdPublico ?? '' },
    });
    if (!usuario) throw new BadRequestException('Cliente não encontrado');

    await this.prisma.liberacaoAdquirenteUsuario.upsert({
      where: {
        provedorPagamentoId_usuarioId: {
          provedorPagamentoId: provedor.id,
          usuarioId: usuario.id,
        },
      },
      create: {
        provedorPagamentoId: provedor.id,
        usuarioId: usuario.id,
        liberadoPorUsuarioId: BigInt(req.user.id),
      },
      update: {},
    });
    return { ok: true };
  }

  /**
   * Tira o cliente da lista de liberados. Se ele estiver USANDO esta adquirente
   * no PIX in, exige a substituta no mesmo request — ninguém pode ficar sem
   * adquirente de entrada.
   */
  @Delete(':codigo/clientes/:usuarioIdPublico')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async revogar(
    @Param('codigo') codigo: string,
    @Param('usuarioIdPublico') usuarioIdPublico: string,
    @Query('adquirenteSubstituta') substituta: string | undefined,
    @Req() req: { user: { id: string } },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
    });
    if (!provedor) throw new BadRequestException('Adquirente não encontrada');
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico: usuarioIdPublico },
    });
    if (!usuario) throw new BadRequestException('Cliente não encontrado');

    const emUso = await this.prisma.configuracaoPixUsuario.findFirst({
      where: { usuarioId: usuario.id, contaEntrada: { provedor: { codigo } } },
    });

    await this.prisma.$transaction(async (tx) => {
      if (emUso) {
        if (!substituta) {
          throw new BadRequestException(
            'Este cliente usa a adquirente no PIX in. Informe `adquirenteSubstituta`.',
          );
        }
        await this.adquirentes.aplicarSubstituicoes(
          tx,
          codigo,
          [{ usuarioIdPublico, adquirenteCodigo: substituta }],
          BigInt(req.user.id),
        );
      }
      await tx.liberacaoAdquirenteUsuario.deleteMany({
        where: { provedorPagamentoId: provedor.id, usuarioId: usuario.id },
      });
    });
    return { ok: true, substituidaPor: emUso ? substituta : null };
  }

  /**
   * Preview do estrago: quem usa esta adquirente hoje e para onde pode ir. É o
   * que o painel consulta antes de deixar o admin confirmar a inativação.
   */
  @Get(':codigo/impacto-pix-entrada')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_VER)
  async impacto(@Param('codigo') codigo: string) {
    const [clientes, alternativas] = await Promise.all([
      this.adquirentes.clientesAfetados(codigo),
      this.adquirentes.alternativasPara(codigo),
    ]);
    return { clientes, alternativas };
  }

  /** Campos de vitrine (o que o cliente vê) — separados do cadastro técnico. */
  @Put(':codigo/vitrine')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async editarVitrine(
    @Param('codigo') codigo: string,
    @Body()
    body: {
      nomeFantasia?: string;
      temMed?: boolean;
      observacaoCliente?: string;
      disponibilidadePixEntrada?: string;
      substituicoes?: Array<{ usuarioIdPublico: string; adquirenteCodigo: string }>;
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const antes = await this.prisma.provedorPagamento.findUnique({ where: { codigo } });
    if (!antes) throw new BadRequestException('Adquirente não encontrada');

    const disponibilidade = body.disponibilidadePixEntrada;
    if (
      disponibilidade &&
      disponibilidade !== DISPONIBILIDADE_ADQUIRENTE.TODOS &&
      disponibilidade !== DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS
    ) {
      throw new BadRequestException('disponibilidadePixEntrada inválida');
    }

    /**
     * Fechar a vitrine (TODOS → ESPECIFICOS) pode deixar sem adquirente quem
     * usava só por ela estar aberta. Remaneja quem não tiver liberação nominal.
     */
    const fechando =
      antes.disponibilidadePixEntrada === DISPONIBILIDADE_ADQUIRENTE.TODOS &&
      disponibilidade === DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS;

    await this.prisma.$transaction(async (tx) => {
      if (fechando) {
        const usando = await tx.configuracaoPixUsuario.findMany({
          where: { contaEntrada: { provedor: { codigo } } },
          include: { usuario: { select: { idPublico: true } } },
        });
        const liberados = await tx.liberacaoAdquirenteUsuario.findMany({
          where: { provedorPagamentoId: antes.id },
          select: { usuarioId: true },
        });
        const comLiberacao = new Set(liberados.map((l) => l.usuarioId.toString()));
        const orfaos = usando.filter(
          (u) => !comLiberacao.has(u.usuarioId.toString()),
        );
        if (orfaos.length > 0) {
          const pedidas = (body.substituicoes ?? []).filter((s) =>
            orfaos.some((o) => o.usuario.idPublico === s.usuarioIdPublico),
          );
          await this.adquirentes.aplicarSubstituicoes(
            tx,
            codigo,
            pedidas,
            BigInt(req.user.id),
          );
        }
      }

      await tx.provedorPagamento.update({
        where: { codigo },
        data: {
          nomeFantasia: body.nomeFantasia?.trim() || null,
          temMed: body.temMed,
          observacaoCliente: body.observacaoCliente?.trim() || null,
          disponibilidadePixEntrada: disponibilidade as never,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'ADQUIRENTE_VITRINE_EDITAR',
          nomeTabela: 'provedores_pagamento',
          chaveRegistro: codigo,
          enderecoIp: req.ip,
          dadosAnteriores: {
            nomeFantasia: antes.nomeFantasia,
            temMed: antes.temMed,
            observacaoCliente: antes.observacaoCliente,
            disponibilidadePixEntrada: antes.disponibilidadePixEntrada,
          },
          dadosNovos: {
            nomeFantasia: body.nomeFantasia ?? null,
            temMed: body.temMed ?? antes.temMed,
            observacaoCliente: body.observacaoCliente ?? null,
            disponibilidadePixEntrada:
              disponibilidade ?? antes.disponibilidadePixEntrada,
          },
        },
      });
    });

    return { ok: true };
  }
}
