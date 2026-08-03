import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  documentosObrigatoriosEmpresa,
  DOCUMENTOS_OBRIGATORIOS_USUARIO,
  PAPEIS,
  reprovarCadastroSchema,
  SITUACAO_ANALISE,
  SITUACAO_DOCUMENTO,
  SITUACAO_PROVEDOR,
  SITUACAO_USUARIO,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { documentosFaltantes } from '../onboarding/onboarding.util';
import { JwtAuthGuard, RolesGuard } from './jwt-auth.guard';

@Controller('admin/usuarios')
@UseGuards(JwtAuthGuard)
export class AdminUsuariosController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  @Get()
  async listar(
    @Query('situacao') situacao: string | undefined,
    @Req() req: { user: { papeis: string[] } },
  ) {
    if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
    const situacoesValidas: string[] = [
      SITUACAO_USUARIO.PENDENTE,
      SITUACAO_USUARIO.EM_ANALISE,
      SITUACAO_USUARIO.ATIVO,
      SITUACAO_USUARIO.REPROVADO,
      SITUACAO_USUARIO.SUSPENSO,
      SITUACAO_USUARIO.BLOQUEADO,
      SITUACAO_USUARIO.ENCERRADO,
    ];
    if (situacao && !situacoesValidas.includes(situacao)) {
      throw new BadRequestException('situacao inválida');
    }
    const usuarios = await this.prisma.usuario.findMany({
      where: situacao ? { situacao: situacao as never } : undefined,
      orderBy: { criadoEm: 'desc' },
      take: 200,
      include: {
        documentos: { select: { situacao: true } },
        empresasProprietario: {
          select: { idPublico: true, razaoSocial: true, situacao: true },
        },
        papeis: { include: { papel: true } },
      },
    });
    return usuarios.map((u) => ({
      idPublico: u.idPublico,
      nomeRazaoSocial: u.nomeRazaoSocial,
      email: u.email,
      cpfCnpj: u.cpfCnpj,
      tipoPessoa: u.tipoPessoa,
      // Para PJ, é o CPF/nome de quem responde pela empresa — o analista compara
      // com o RG/CNH e a selfie enviados.
      responsavel: { cpf: u.cpfResponsavel, nome: u.nomeResponsavel },
      situacao: u.situacao,
      criadoEm: u.criadoEm.toISOString(),
      papeis: u.papeis.map((p) => p.papel.nome),
      documentos: {
        total: u.documentos.length,
        pendentes: u.documentos.filter(
          (d) => d.situacao === SITUACAO_DOCUMENTO.PENDENTE,
        ).length,
        validos: u.documentos.filter(
          (d) => d.situacao === SITUACAO_DOCUMENTO.VALIDO,
        ).length,
        invalidos: u.documentos.filter(
          (d) => d.situacao === SITUACAO_DOCUMENTO.INVALIDO,
        ).length,
      },
      empresas: u.empresasProprietario,
    }));
  }

  private assertAdmin(papeis: string[]) {
    if (!papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
  }

  /** Listagem de gestão de usuários: paginada (server-side) + busca. */
  @Get('gestao')
  async gestao(
    @Query() q: Record<string, string>,
    @Req() req: { user: { papeis: string[] } },
  ) {
    this.assertAdmin(req.user.papeis);
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));
    const where: Record<string, unknown> = {};
    const situacoesValidas = Object.values(SITUACAO_USUARIO) as string[];
    if (q.situacao && situacoesValidas.includes(q.situacao)) where.situacao = q.situacao;
    const busca = (q.busca ?? '').trim();
    if (busca) {
      where.OR = [
        { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
        { cpfCnpj: { contains: busca.replace(/\D/g, '') } },
      ];
    }
    const [total, usuarios] = await Promise.all([
      this.prisma.usuario.count({ where: where as never }),
      this.prisma.usuario.findMany({
        where: where as never,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          empresasProprietario: {
            select: { idPublico: true, razaoSocial: true, situacao: true },
          },
          papeis: { include: { papel: true } },
        },
      }),
    ]);
    return {
      pagina,
      limite,
      total,
      itens: usuarios.map((u) => ({
        idPublico: u.idPublico,
        nome: u.nomeRazaoSocial,
        email: u.email,
        cpfCnpj: u.cpfCnpj,
        tipoPessoa: u.tipoPessoa,
        situacao: u.situacao,
        criadoEm: u.criadoEm.toISOString(),
        papeis: u.papeis.map((p) => p.papel.nome),
        empresas: u.empresasProprietario,
      })),
    };
  }

  /** Muda o status de um usuário já processado (ATIVO/SUSPENSO/BLOQUEADO/ENCERRADO). */
  @Put(':idPublico/situacao')
  async mudarSituacao(
    @Param('idPublico') idPublico: string,
    @Body() body: { situacao?: string },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const permitidas: string[] = [
      SITUACAO_USUARIO.ATIVO,
      SITUACAO_USUARIO.SUSPENSO,
      SITUACAO_USUARIO.BLOQUEADO,
      SITUACAO_USUARIO.ENCERRADO,
    ];
    if (!body.situacao || !permitidas.includes(body.situacao)) {
      throw new BadRequestException(
        'Situação inválida (ATIVO, SUSPENSO, BLOQUEADO ou ENCERRADO).',
      );
    }
    const u = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!u) throw new BadRequestException('Usuário não encontrado');
    if (
      u.situacao === SITUACAO_USUARIO.PENDENTE ||
      u.situacao === SITUACAO_USUARIO.EM_ANALISE
    ) {
      throw new BadRequestException(
        'Cadastro em onboarding: use Aprovações (aprovar/reprovar).',
      );
    }
    const nova = body.situacao;
    await this.prisma.usuario.update({
      where: { idPublico },
      data: {
        situacao: nova as never,
        contaBloqueada: nova === SITUACAO_USUARIO.BLOQUEADO,
      },
    });
    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: BigInt(req.user.id),
        usuarioAfetadoId: u.id,
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao: `USUARIO_SITUACAO_${nova}`,
        nomeTabela: 'usuarios',
        chaveRegistro: u.id.toString(),
        enderecoIp: req.ip,
        dadosAnteriores: { situacao: u.situacao } as never,
        dadosNovos: { situacao: nova } as never,
      },
    });
    return { idPublico, situacao: nova };
  }

  /** Taxas + adquirente de roteamento do usuário (fallback: padrão do sistema). */
  @Get(':idPublico/config')
  async config(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { papeis: string[] } },
  ) {
    this.assertAdmin(req.user.papeis);
    const u = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!u) throw new BadRequestException('Usuário não encontrado');
    const cfg = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId: u.id },
      include: {
        contaEntrada: { include: { provedor: true } },
        contaSaida: { include: { provedor: true } },
      },
    });
    const padrao = cfg
      ? null
      : await this.prisma.configuracaoPadraoPixUsuario.findFirst({
          where: { padraoSistema: true },
          include: {
            contaEntrada: { include: { provedor: true } },
            contaSaida: { include: { provedor: true } },
          },
        });
    const base = cfg ?? padrao;
    return {
      temConfig: !!cfg,
      taxaPixEntradaPercentual: (base?.taxaPixEntradaPercentual ?? 0).toString(),
      taxaPixEntradaFixa: (base?.taxaPixEntradaFixa ?? 0).toString(),
      taxaPixSaidaPercentual: (base?.taxaPixSaidaPercentual ?? 0).toString(),
      taxaPixSaidaFixa: (base?.taxaPixSaidaFixa ?? 0).toString(),
      diasLiberacaoSaldo: base?.diasLiberacaoSaldo ?? 0,
      percentualReserva: (base?.percentualReserva ?? 0).toString(),
      adquirenteEntrada: base?.contaEntrada?.provedor?.codigo ?? null,
      adquirenteSaida: base?.contaSaida?.provedor?.codigo ?? null,
    };
  }

  @Put(':idPublico/config')
  async editarConfig(
    @Param('idPublico') idPublico: string,
    @Body() body: Record<string, string>,
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const u = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!u) throw new BadRequestException('Usuário não encontrado');
    const cfg = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId: u.id },
    });
    const padrao = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true },
    });

    const resolverConta = async (codigo: string | undefined, direcao: 'entrada' | 'saida') => {
      if (!codigo) return null;
      const c = await this.prisma.contaProvedor.findFirst({
        where: {
          provedor: { codigo },
          situacao: SITUACAO_PROVEDOR.ATIVO,
          ...(direcao === 'entrada'
            ? { pixEntradaHabilitado: true }
            : { pixSaidaHabilitado: true }),
        },
        orderBy: { id: 'asc' },
      });
      if (!c) throw new BadRequestException(`Adquirente ${codigo} sem conta ativa para ${direcao}.`);
      return c.id;
    };

    const contaEntradaId =
      (await resolverConta(body.adquirenteEntrada, 'entrada')) ??
      cfg?.contaProvedorPixEntradaId ??
      padrao?.contaProvedorPixEntradaId;
    const contaSaidaId =
      (await resolverConta(body.adquirenteSaida, 'saida')) ??
      cfg?.contaProvedorPixSaidaId ??
      padrao?.contaProvedorPixSaidaId;
    if (!contaEntradaId || !contaSaidaId) {
      throw new BadRequestException('Defina as adquirentes de cash-in e cash-out.');
    }

    const dec = (v: unknown, campo: string) => {
      const n = Number(v);
      if (!isFinite(n) || n < 0) throw new BadRequestException(`${campo} inválido`);
      return n;
    };
    const int = (v: unknown, campo: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new BadRequestException(`${campo} inválido`);
      return n;
    };
    const taxas = {
      taxaPixEntradaPercentual: dec(body.taxaPixEntradaPercentual, 'taxaPixEntradaPercentual'),
      taxaPixEntradaFixa: dec(body.taxaPixEntradaFixa, 'taxaPixEntradaFixa'),
      taxaPixSaidaPercentual: dec(body.taxaPixSaidaPercentual, 'taxaPixSaidaPercentual'),
      taxaPixSaidaFixa: dec(body.taxaPixSaidaFixa, 'taxaPixSaidaFixa'),
      diasLiberacaoSaldo: int(body.diasLiberacaoSaldo, 'diasLiberacaoSaldo'),
      percentualReserva: dec(body.percentualReserva, 'percentualReserva'),
      contaProvedorPixEntradaId: contaEntradaId,
      contaProvedorPixSaidaId: contaSaidaId,
      atualizadoPorUsuarioId: BigInt(req.user.id),
    };

    await this.prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId: u.id },
      // Ao criar, herda o resto (ticket, reserva base, MED, etc.) do padrão.
      create: {
        usuarioId: u.id,
        configuracaoPadraoOrigemId: padrao?.id,
        ticketMinimoPixEntrada: padrao?.ticketMinimoPixEntrada ?? 0,
        ticketMaximoPixEntrada: padrao?.ticketMaximoPixEntrada ?? 100000,
        ticketMinimoPixSaida: padrao?.ticketMinimoPixSaida ?? 0,
        ticketMaximoPixSaida: padrao?.ticketMaximoPixSaida ?? undefined,
        permitirPixSaidaViaApi: padrao?.permitirPixSaidaViaApi ?? false,
        baseCalculoReserva: padrao?.baseCalculoReserva,
        diasRetencaoReserva: padrao?.diasRetencaoReserva ?? 0,
        modoTratamentoMed: padrao?.modoTratamentoMed,
        permiteSaldoNegativo: padrao?.permiteSaldoNegativo ?? false,
        ...taxas,
      },
      update: taxas,
    });

    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: BigInt(req.user.id),
        usuarioAfetadoId: u.id,
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao: 'USUARIO_TAXAS_EDITAR',
        nomeTabela: 'configuracoes_pix_usuarios',
        chaveRegistro: u.id.toString(),
        enderecoIp: req.ip,
        dadosNovos: {
          adquirenteEntrada: body.adquirenteEntrada,
          adquirenteSaida: body.adquirenteSaida,
          taxaPixEntradaPercentual: body.taxaPixEntradaPercentual,
          taxaPixSaidaPercentual: body.taxaPixSaidaPercentual,
        } as never,
      },
    });
    return { ok: true };
  }

  @Post(':idPublico/ativar')
  async ativar(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: {
        documentos: true,
        empresasProprietario: { include: { documentos: true } },
      },
    });
    if (!usuario) throw new BadRequestException('Usuário não encontrado');

    // Gate de aprovação: só ativa cadastro que passou pelo envio de documentação
    // (EM_ANALISE) e sem documento obrigatório reprovado.
    if (usuario.situacao !== SITUACAO_USUARIO.EM_ANALISE) {
      throw new BadRequestException(
        `Usuário não está em análise (situação atual: ${usuario.situacao}). ` +
          'A documentação precisa ser enviada antes da aprovação.',
      );
    }
    const obrigatoriosInvalidos = DOCUMENTOS_OBRIGATORIOS_USUARIO.filter((tipo) =>
      usuario.documentos.some(
        (d) =>
          d.tipoDocumento === tipo && d.situacao === SITUACAO_DOCUMENTO.INVALIDO,
      ) &&
      !usuario.documentos.some(
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

    // Furo de KYC fechado: um PJ chega a EM_ANALISE só com os documentos
    // pessoais do responsável. Sem esta checagem o admin poderia ativar a conta
    // antes de qualquer documento societário ter sido enviado.
    for (const empresa of usuario.empresasProprietario) {
      const faltam = documentosFaltantes(
        documentosObrigatoriosEmpresa(empresa.tipoPessoa),
        empresa.documentos,
      );
      if (faltam.length > 0) {
        throw new BadRequestException(
          `A empresa ${empresa.razaoSocial} ainda não enviou: ${faltam.join(', ')}.`,
        );
      }
    }

    const padrao = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true, ativo: true },
    });
    if (!padrao) {
      throw new BadRequestException('Configuração padrão PIX não encontrada');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          situacao: SITUACAO_USUARIO.ATIVO,
          ativadoEm: new Date(),
          ativadoPorUsuarioId: BigInt(req.user.id),
          contaBloqueada: false,
        },
      });
      await tx.historicoSituacaoUsuario.create({
        data: {
          usuarioId: usuario.id,
          situacaoAnterior: usuario.situacao,
          novaSituacao: SITUACAO_USUARIO.ATIVO,
          motivo: 'Ativação administrativa',
          usuarioAtorId: BigInt(req.user.id),
        },
      });
      await tx.configuracaoPixUsuario.upsert({
        where: { usuarioId: usuario.id },
        create: {
          usuarioId: usuario.id,
          configuracaoPadraoOrigemId: padrao.id,
          contaProvedorPixEntradaId: padrao.contaProvedorPixEntradaId,
          contaProvedorPixSaidaId: padrao.contaProvedorPixSaidaId,
          taxaPixEntradaPercentual: padrao.taxaPixEntradaPercentual,
          taxaPixEntradaFixa: padrao.taxaPixEntradaFixa,
          taxaPixSaidaPercentual: padrao.taxaPixSaidaPercentual,
          taxaPixSaidaFixa: padrao.taxaPixSaidaFixa,
          ticketMinimoPixEntrada: padrao.ticketMinimoPixEntrada,
          ticketMaximoPixEntrada: padrao.ticketMaximoPixEntrada,
          ticketMinimoPixSaida: padrao.ticketMinimoPixSaida,
          ticketMaximoPixSaida: padrao.ticketMaximoPixSaida,
          permitirPixSaidaViaApi: padrao.permitirPixSaidaViaApi,
          diasLiberacaoSaldo: padrao.diasLiberacaoSaldo,
          percentualReserva: padrao.percentualReserva,
          baseCalculoReserva: padrao.baseCalculoReserva,
          diasRetencaoReserva: padrao.diasRetencaoReserva,
          modoTratamentoMed: padrao.modoTratamentoMed,
          permiteSaldoNegativo: padrao.permiteSaldoNegativo,
        },
        update: {},
      });
      await tx.analiseCadastroUsuario.updateMany({
        where: {
          usuarioId: usuario.id,
          situacao: {
            in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE],
          },
        },
        data: {
          situacao: SITUACAO_ANALISE.APROVADA,
          analisadoPorUsuarioId: BigInt(req.user.id),
          analisadoEm: new Date(),
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: usuario.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'USUARIO_ATIVAR',
          nomeTabela: 'usuarios',
          chaveRegistro: usuario.id.toString(),
        },
      });
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.CONTA_APROVADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
      dados: { url: `${process.env.WEB_URL ?? 'http://localhost:3000'}/login` },
    });

    return { ok: true, situacao: SITUACAO_USUARIO.ATIVO };
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

    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new BadRequestException('Usuário não encontrado');
    if (usuario.situacao === SITUACAO_USUARIO.ATIVO) {
      throw new BadRequestException('Usuário já ativo — use suspensão/bloqueio.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          situacao: SITUACAO_USUARIO.REPROVADO,
          motivoReprovacao: parsed.data.motivo,
        },
      });
      await tx.historicoSituacaoUsuario.create({
        data: {
          usuarioId: usuario.id,
          situacaoAnterior: usuario.situacao,
          novaSituacao: SITUACAO_USUARIO.REPROVADO,
          motivo: parsed.data.motivo,
          usuarioAtorId: BigInt(req.user.id),
        },
      });
      await tx.analiseCadastroUsuario.updateMany({
        where: {
          usuarioId: usuario.id,
          situacao: {
            in: [SITUACAO_ANALISE.PENDENTE, SITUACAO_ANALISE.EM_ANALISE],
          },
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
          usuarioAfetadoId: usuario.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'USUARIO_REPROVAR',
          nomeTabela: 'usuarios',
          chaveRegistro: usuario.id.toString(),
        },
      });
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.CONTA_REPROVADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
      dados: { motivo: parsed.data.motivo },
    });

    return { ok: true, situacao: SITUACAO_USUARIO.REPROVADO };
  }
}
