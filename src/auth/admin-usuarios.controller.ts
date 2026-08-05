import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  DISPONIBILIDADE_ADQUIRENTE,
  documentosObrigatorios,
  PAPEIS,
  PERMISSOES,
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
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequerPermissao } from './permissoes.decorator';

@Controller('admin/usuarios')
@UseGuards(JwtAuthGuard)
export class AdminUsuariosController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_VER)
  async listar(@Query('situacao') situacao: string | undefined) {
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
        papeis: { include: { papel: true } },
      },
    });
    return usuarios.map((u) => ({
      idPublico: u.idPublico,
      nomeRazaoSocial: u.nomeRazaoSocial,
      email: u.email,
      cpfCnpj: u.cpfCnpj,
      tipoPessoa: u.tipoPessoa,
      // Para PJ, é o CPF/nome de quem responde pela pessoa jurídica — o analista compara
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
    }));
  }

  /**
   * Perfis que podem ser atribuídos na edição do usuário. Endpoint próprio (e
   * não `/admin/perfis`) para quem gerencia usuários não precisar também da
   * permissão de gerenciar perfis.
   */
  @Get('perfis-disponiveis')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async perfisDisponiveis() {
    const papeis = await this.prisma.papel.findMany({
      where: { ativo: true },
      orderBy: { nome: 'asc' },
      select: { nome: true, descricao: true },
    });
    return papeis;
  }

  /** Listagem de gestão de usuários: paginada (server-side) + busca. */
  @Get('gestao')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async gestao(@Query() q: Record<string, string>) {
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
        include: { papeis: { include: { papel: true } } },
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
      })),
    };
  }

  /**
   * Ficha completa do cliente para a tela de edição/consulta do admin: dados
   * pessoais e cadastrais, endereço, documentos, saldo, histórico de situação
   * e aceites legais.
   *
   * Nunca devolve `senhaHash` nem `segredoTotpCriptografado` — só o indicador
   * de que o 2FA está ativo.
   */
  @Get(':idPublico/detalhe')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async detalhe(@Param('idPublico') idPublico: string) {
    const u = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: {
        documentos: { orderBy: { enviadoEm: 'desc' } },
        papeis: { include: { papel: true } },
        ativadoPor: { select: { nomeRazaoSocial: true, email: true } },
        historicosSituacao: { orderBy: { criadoEm: 'desc' }, take: 50 },
        aceitesLegais: { orderBy: { aceitoEm: 'desc' } },
        saldo: true,
      },
    });
    if (!u) throw new NotFoundException('Usuário não encontrado');

    const contar = (docs: Array<{ situacao: string }>) => ({
      total: docs.length,
      pendentes: docs.filter((d) => d.situacao === SITUACAO_DOCUMENTO.PENDENTE).length,
      validos: docs.filter((d) => d.situacao === SITUACAO_DOCUMENTO.VALIDO).length,
      invalidos: docs.filter((d) => d.situacao === SITUACAO_DOCUMENTO.INVALIDO).length,
    });

    return {
      idPublico: u.idPublico,
      tipoPessoa: u.tipoPessoa,
      cpfCnpj: u.cpfCnpj,
      nomeRazaoSocial: u.nomeRazaoSocial,
      nomeFantasia: u.nomeFantasia,
      email: u.email,
      telefone: u.telefone,
      situacao: u.situacao,
      contaBloqueada: u.contaBloqueada,
      forcarTrocaSenha: u.forcarTrocaSenha,
      totpHabilitado: u.totpHabilitado,
      totpAtivadoEm: u.totpAtivadoEm?.toISOString() ?? null,
      // Para PJ é quem responde pela pessoa jurídica; para PF espelha o titular.
      responsavel: { nome: u.nomeResponsavel, cpf: u.cpfResponsavel },
      endereco: u.endereco,
      faturamentoMensalMedio: u.faturamentoMensalMedio?.toString() ?? null,
      papeis: u.papeis.map((p) => p.papel.nome),
      motivoReprovacao: u.motivoReprovacao,
      criadoEm: u.criadoEm.toISOString(),
      atualizadoEm: u.atualizadoEm.toISOString(),
      ultimoAcessoEm: u.ultimoAcessoEm?.toISOString() ?? null,
      ativadoEm: u.ativadoEm?.toISOString() ?? null,
      ativadoPor: u.ativadoPor
        ? { nome: u.ativadoPor.nomeRazaoSocial, email: u.ativadoPor.email }
        : null,
      documentos: {
        resumo: contar(u.documentos),
        faltantes: documentosFaltantes(
          documentosObrigatorios(u.tipoPessoa),
          u.documentos,
        ),
      },
      saldo: u.saldo
        ? {
            disponivel: u.saldo.saldoDisponivel.toString(),
            pendenteLiberacao: u.saldo.saldoPendenteLiberacao.toString(),
            reservado: u.saldo.saldoReservado.toString(),
            bloqueadoMed: u.saldo.saldoBloqueadoMed.toString(),
            atualizadoEm: u.saldo.atualizadoEm.toISOString(),
          }
        : null,
      historicoSituacao: u.historicosSituacao.map((h) => ({
        id: h.id.toString(),
        situacaoAnterior: h.situacaoAnterior,
        novaSituacao: h.novaSituacao,
        motivo: h.motivo,
        enderecoIp: h.enderecoIp,
        criadoEm: h.criadoEm.toISOString(),
      })),
      aceitesLegais: u.aceitesLegais.map((a) => ({
        id: a.id.toString(),
        documento: a.documento,
        versao: a.versao,
        enderecoIp: a.enderecoIp,
        agenteUsuario: a.agenteUsuario,
        aceitoEm: a.aceitoEm.toISOString(),
      })),
    };
  }

  /** Muda o status de um usuário já processado (ATIVO/SUSPENSO/BLOQUEADO/ENCERRADO). */
  @Put(':idPublico/situacao')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async mudarSituacao(
    @Param('idPublico') idPublico: string,
    @Body() body: { situacao?: string },
    @Req() req: { user: { id: string }; ip?: string },
  ) {
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
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async config(@Param('idPublico') idPublico: string) {
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
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async editarConfig(
    @Param('idPublico') idPublico: string,
    @Body() body: Record<string, string>,
    @Req() req: { user: { id: string }; ip?: string },
  ) {
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

    // O admin escolher a adquirente de PIX in para o cliente IMPLICA liberá-la
    // na vitrine: sem isso a conta ficaria roteando por uma adquirente que ela
    // não pode selecionar no painel — e a própria cobrança seria recusada.
    if (body.adquirenteEntrada) {
      const provedor = await this.prisma.provedorPagamento.findUnique({
        where: { codigo: body.adquirenteEntrada },
      });
      if (
        provedor?.disponibilidadePixEntrada === DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS
      ) {
        await this.prisma.liberacaoAdquirenteUsuario.upsert({
          where: {
            provedorPagamentoId_usuarioId: {
              provedorPagamentoId: provedor.id,
              usuarioId: u.id,
            },
          },
          create: {
            provedorPagamentoId: provedor.id,
            usuarioId: u.id,
            liberadoPorUsuarioId: BigInt(req.user.id),
          },
          update: {},
        });
      }
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
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_APROVAR)
  async ativar(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { id: string } },
  ) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: { documentos: true },
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
    const exigidos = documentosObrigatorios(usuario.tipoPessoa);
    const obrigatoriosInvalidos = exigidos.filter((tipo) =>
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
    const faltantes = documentosFaltantes(exigidos, usuario.documentos);
    if (faltantes.length > 0) {
      throw new BadRequestException(
        `Documentação incompleta — ainda falta: ${faltantes.join(', ')}.`,
      );
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
      // Carteira do cliente: nasce zerada junto da ativação. Sem ela o primeiro
      // crédito não tem onde cair.
      await tx.saldoUsuario.upsert({
        where: { usuarioId: usuario.id },
        create: { usuarioId: usuario.id },
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
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_APROVAR)
  async reprovar(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: { user: { id: string } },
  ) {
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

  /**
   * Perfis de acesso do usuário. Substitui o conjunto inteiro — o corpo é a
   * lista final de nomes de perfil.
   */
  @Put(':idPublico/perfis')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async definirPerfis(
    @Param('idPublico') idPublico: string,
    @Body() body: { perfis?: string[] },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    const nomes = Array.from(new Set(body?.perfis ?? []));
    if (!Array.isArray(body?.perfis)) {
      throw new BadRequestException('Informe `perfis` (lista de nomes).');
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: { papeis: { include: { papel: true } } },
    });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const papeis = await this.prisma.papel.findMany({
      where: { nome: { in: nomes } },
    });
    const faltando = nomes.filter((n) => !papeis.some((p) => p.nome === n));
    if (faltando.length) {
      throw new BadRequestException(`Perfil inexistente: ${faltando.join(', ')}`);
    }

    const anteriores = usuario.papeis.map((p) => p.papel.nome);
    // Trava anti-lockout: o admin não tira o próprio ADMINISTRADOR. Se tirasse,
    // ninguém mais conseguiria devolver o perfil — a tela exige a permissão.
    if (
      usuario.id.toString() === req.user.id &&
      anteriores.includes(PAPEIS.ADMINISTRADOR) &&
      !nomes.includes(PAPEIS.ADMINISTRADOR)
    ) {
      throw new BadRequestException(
        'Você não pode remover o próprio perfil ADMINISTRADOR.',
      );
    }

    /**
     * Barreira anti-escalação: quem não é ADMINISTRADOR não pode CONCEDER
     * ADMINISTRADOR — nem a si mesmo, nem a terceiro.
     *
     * Sem isto, `admin.usuarios.editar` (um perfil delegado de "gerente de
     * contas") valia superusuário: bastava atribuir ADMINISTRADOR à própria
     * conta, porque `permissoesEfetivas` devolve TODAS_PERMISSOES para esse
     * papel e as permissões são reresolvidas no banco a cada request — a
     * promoção passa a valer na requisição seguinte, com o MESMO token.
     */
    if (
      nomes.includes(PAPEIS.ADMINISTRADOR) &&
      !anteriores.includes(PAPEIS.ADMINISTRADOR) &&
      !req.user.papeis.includes(PAPEIS.ADMINISTRADOR)
    ) {
      throw new BadRequestException(
        'Somente um ADMINISTRADOR pode conceder o perfil ADMINISTRADOR.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.usuarioPapel.deleteMany({ where: { usuarioId: usuario.id } });
      if (papeis.length) {
        await tx.usuarioPapel.createMany({
          data: papeis.map((p) => ({ usuarioId: usuario.id, papelId: p.id })),
        });
      }
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: usuario.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'USUARIO_PERFIS_DEFINIR',
          nomeTabela: 'usuarios_papeis',
          chaveRegistro: usuario.id.toString(),
          enderecoIp: req.ip,
          dadosAnteriores: { perfis: anteriores } as never,
          dadosNovos: { perfis: nomes } as never,
        },
      });
    });

    return { idPublico, perfis: nomes };
  }
}
