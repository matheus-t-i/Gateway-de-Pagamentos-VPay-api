import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import {
  BASE_CALCULO_RESERVA,
  DISPONIBILIDADE_ADQUIRENTE,
  documentosObrigatorios,
  MODO_TRATAMENTO_MED,
  normalizarIpOuCidr,
  PAPEIS,
  PERMISSOES,
  reprovarCadastroSchema,
  SITUACAO_ANALISE,
  SITUACAO_DOCUMENTO,
  SITUACAO_PROVEDOR,
  SITUACAO_USUARIO,
  TIPOS_EMAIL,
  violacoesSenha,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { documentosFaltantes } from '../onboarding/onboarding.util';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequerPermissao } from './permissoes.decorator';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
  stepUpBodySchema,
} from '../common/step-up-totp';

const stepUpSchema = stepUpBodySchema;

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
    // Lista separada por vírgula: a tela de Aprovações trata PENDENTE (aguardando
    // o cliente enviar documento) e EM_ANALISE (aguardando o admin decidir) como
    // UMA fila só — são as duas situações que ainda precisam de atenção, e
    // separá-las em abas escondia a metade da fila de quem abria a tela.
    const lista = situacao ? situacao.split(',').map((s) => s.trim()) : [];
    const invalida = lista.find((s) => !situacoesValidas.includes(s));
    if (invalida) {
      throw new BadRequestException(`situacao inválida: ${invalida}`);
    }
    const usuarios = await this.prisma.usuario.findMany({
      where: lista.length ? { situacao: { in: lista as never[] } } : undefined,
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

  /**
   * Condições comerciais aplicadas a TODO cliente novo na ativação
   * (`configuracoes_padrao_pix_usuarios`, linha `padraoSistema`).
   *
   * Mora em `admin/usuarios` — e não junto das adquirentes — porque o que se
   * configura aqui é o contrato do cliente (taxa, prazo de liberação, reserva,
   * MED), não a integração com a liquidante.
   */
  @Get('config-padrao')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async configPadrao() {
    const c = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true },
    });
    if (!c) {
      throw new NotFoundException('Configuração padrão do sistema não encontrada');
    }
    return {
      taxaPixEntradaPercentual: c.taxaPixEntradaPercentual.toString(),
      taxaPixEntradaFixa: c.taxaPixEntradaFixa.toString(),
      taxaPixSaidaPercentual: c.taxaPixSaidaPercentual.toString(),
      taxaPixSaidaFixa: c.taxaPixSaidaFixa.toString(),
      ticketMinimoPixEntrada: c.ticketMinimoPixEntrada.toString(),
      ticketMaximoPixEntrada: c.ticketMaximoPixEntrada.toString(),
      limiteDiarioPixSaida: c.limiteDiarioPixSaida?.toString() ?? '',
      maxSaquesPorHora: c.maxSaquesPorHora?.toString() ?? '',
      diasLiberacaoSaldo: c.diasLiberacaoSaldo,
      percentualReserva: c.percentualReserva.toString(),
      baseCalculoReserva: c.baseCalculoReserva,
      diasRetencaoReserva: c.diasRetencaoReserva,
      modoTratamentoMed: c.modoTratamentoMed,
      permiteSaldoNegativo: permiteNegativo(
        c.permiteSaldoNegativo,
        c.modoTratamentoMed,
      ),
      origemSaquePermitida: c.origemSaquePermitida,
      exigirChavePixCadastrada: c.exigirChavePixCadastrada,
    };
  }

  @Put('config-padrao')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async editarConfigPadrao(
    @Body() body: Record<string, string>,
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const c = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true },
    });
    if (!c) {
      throw new NotFoundException('Configuração padrão do sistema não encontrada');
    }
    const regras = regrasComerciais(body);
    const antes = {
      taxaPixEntradaPercentual: c.taxaPixEntradaPercentual.toString(),
      taxaPixEntradaFixa: c.taxaPixEntradaFixa.toString(),
      taxaPixSaidaPercentual: c.taxaPixSaidaPercentual.toString(),
      taxaPixSaidaFixa: c.taxaPixSaidaFixa.toString(),
      diasLiberacaoSaldo: c.diasLiberacaoSaldo,
      percentualReserva: c.percentualReserva.toString(),
      diasRetencaoReserva: c.diasRetencaoReserva,
      baseCalculoReserva: c.baseCalculoReserva,
      modoTratamentoMed: c.modoTratamentoMed,
    };
    await this.prisma.configuracaoPadraoPixUsuario.update({
      where: { id: c.id },
      data: regras,
    });
    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: BigInt(req.user.id),
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao: 'CONFIG_PADRAO_CLIENTE_EDITAR',
        nomeTabela: 'configuracoes_padrao_pix_usuarios',
        chaveRegistro: c.id.toString(),
        enderecoIp: req.ip,
        dadosAnteriores: antes as never,
        dadosNovos: regras as never,
      },
    });
    // Vale para cadastro novo: quem já tem configuração própria não é tocado.
    return { ok: true };
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
      const somenteDigitos = busca.replace(/\D/g, '');
      where.OR = [
        { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
        // `contains: ''` bate com qualquer registro no Prisma — só entra na
        // busca se sobrou pelo menos um dígito, senão a OR vira "todo mundo".
        ...(somenteDigitos ? [{ cpfCnpj: { contains: somenteDigitos } }] : []),
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
        configuracaoPix: true,
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
            bloqueadoManual: u.saldo.saldoBloqueadoManual.toString(),
            atualizadoEm: u.saldo.atualizadoEm.toISOString(),
          }
        : null,
      // Regras vigentes ao lado da carteira: é o que explica cada saldo parado
      // (a liberar, reservado, bloqueado por MED) sem abrir outro formulário.
      regras: u.configuracaoPix
        ? {
            diasLiberacaoSaldo: u.configuracaoPix.diasLiberacaoSaldo,
            percentualReserva: u.configuracaoPix.percentualReserva.toString(),
            diasRetencaoReserva: u.configuracaoPix.diasRetencaoReserva,
            baseCalculoReserva: u.configuracaoPix.baseCalculoReserva,
            modoTratamentoMed: u.configuracaoPix.modoTratamentoMed,
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
    @Body() body: { situacao?: string; codigoTotp?: string },
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
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
      baseCalculoReserva:
        base?.baseCalculoReserva ?? BASE_CALCULO_RESERVA.VALOR_LIQUIDO_EMPRESA,
      diasRetencaoReserva: base?.diasRetencaoReserva ?? 0,
      modoTratamentoMed:
        base?.modoTratamentoMed ?? MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
      permiteSaldoNegativo: permiteNegativo(
        base?.permiteSaldoNegativo ?? false,
        base?.modoTratamentoMed,
      ),
      ticketMinimoPixEntrada: (base?.ticketMinimoPixEntrada ?? 0).toString(),
      ticketMaximoPixEntrada: (base?.ticketMaximoPixEntrada ?? 0).toString(),
      ticketMinimoPixSaida: (base?.ticketMinimoPixSaida ?? 0).toString(),
      ticketMaximoPixSaida: base?.ticketMaximoPixSaida?.toString() ?? '',
      limiteDiarioPixSaida: base?.limiteDiarioPixSaida?.toString() ?? '',
      maxSaquesPorHora: base?.maxSaquesPorHora?.toString() ?? '',
      saqueBloqueadoPorAbuso: cfg?.saqueBloqueadoPorAbuso ?? false,
      saqueBloqueadoPorAbusoMotivo: cfg?.saqueBloqueadoPorAbusoMotivo ?? null,
      origemSaquePermitida: base?.origemSaquePermitida ?? 'PAINEL',
      exigirChavePixCadastrada: base?.exigirChavePixCadastrada ?? true,
      retencaoMetodoAtivo: cfg?.retencaoMetodoAtivo ?? false,
      percentualRetencaoMetodo: (cfg?.percentualRetencaoMetodo ?? 0).toString(),
      medAutomaticoAtivo: cfg?.medAutomaticoAtivo ?? false,
      percentualMedAutomatico: (cfg?.percentualMedAutomatico ?? 0).toString(),
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
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
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

    const taxas = {
      ...regrasComerciais(body),
      retencaoMetodoAtivo: body.retencaoMetodoAtivo === 'true',
      percentualRetencaoMetodo: (() => {
        const n = dec(body.percentualRetencaoMetodo ?? '0', 'percentualRetencaoMetodo');
        if (n > 100) throw new BadRequestException('percentualRetencaoMetodo máximo é 100');
        return n;
      })(),
      medAutomaticoAtivo: body.medAutomaticoAtivo === 'true',
      percentualMedAutomatico: (() => {
        const n = dec(body.percentualMedAutomatico ?? '0', 'percentualMedAutomatico');
        if (n > 100) throw new BadRequestException('percentualMedAutomatico máximo é 100');
        return n;
      })(),
      contaProvedorPixEntradaId: contaEntradaId,
      contaProvedorPixSaidaId: contaSaidaId,
      atualizadoPorUsuarioId: BigInt(req.user.id),
    };

    await this.prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId: u.id },
      // Ticket de saída vem do formulário (regrasComerciais). Fallback do padrão
      // só se o corpo não trouxe — cobre save antigo / cliente sem o campo.
      create: {
        usuarioId: u.id,
        configuracaoPadraoOrigemId: padrao?.id,
        ticketMinimoPixSaida: padrao?.ticketMinimoPixSaida ?? 0,
        ticketMaximoPixSaida: padrao?.ticketMaximoPixSaida ?? undefined,
        limiteDiarioPixSaida: padrao?.limiteDiarioPixSaida ?? undefined,
        maxSaquesPorHora: padrao?.maxSaquesPorHora ?? undefined,
        ...taxas,
      },
      update: {
        ...taxas,
        ...(body.limparBloqueioSaqueAbuso === 'true'
          ? {
              saqueBloqueadoPorAbuso: false,
              saqueBloqueadoPorAbusoEm: null,
              saqueBloqueadoPorAbusoMotivo: null,
            }
          : {}),
      },
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
          // Regras que mexem em quando (e se) o cliente recebe o dinheiro.
          diasLiberacaoSaldo: taxas.diasLiberacaoSaldo,
          percentualReserva: taxas.percentualReserva,
          diasRetencaoReserva: taxas.diasRetencaoReserva,
          baseCalculoReserva: taxas.baseCalculoReserva,
          modoTratamentoMed: taxas.modoTratamentoMed,
        } as never,
      },
    });
    return { ok: true };
  }

  @Post(':idPublico/ativar')
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_APROVAR)
  async ativar(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: { user: { id: string } },
  ) {
    const step = stepUpSchema.safeParse(body ?? {});
    if (!step.success) throw new BadRequestException(step.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, step.data.codigoTotp);

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
          limiteDiarioPixSaida: padrao.limiteDiarioPixSaida,
          maxSaquesPorHora: padrao.maxSaquesPorHora,
          permitirPixSaidaViaApi: padrao.permitirPixSaidaViaApi,
          origemSaquePermitida: padrao.origemSaquePermitida,
          exigirChavePixCadastrada: padrao.exigirChavePixCadastrada,
          diasLiberacaoSaldo: padrao.diasLiberacaoSaldo,
          percentualReserva: padrao.percentualReserva,
          baseCalculoReserva: padrao.baseCalculoReserva,
          diasRetencaoReserva: padrao.diasRetencaoReserva,
          modoTratamentoMed: padrao.modoTratamentoMed,
          // Coerção também aqui porque o padrão pode ter sido gravado antes da
          // regra existir (linha antiga com débito direto e flag desligada).
          permiteSaldoNegativo: permiteNegativo(
            padrao.permiteSaldoNegativo,
            padrao.modoTratamentoMed,
          ),
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
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);

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
   *
   * Exige a permissão de **perfis**, não a de usuários: conceder perfil é
   * distribuir poder, então quem administra contas (taxas, situação, limites)
   * não ganha de brinde a chave de promover gente. A tela que usa isto é
   * `/admin/perfis`.
   */
  @Put(':idPublico/perfis')
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_EDITAR)
  async definirPerfis(
    @Param('idPublico') idPublico: string,
    @Body() body: { perfis?: string[]; codigoTotp?: string },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Ações de segurança da conta do cliente
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Desliga o 2FA da conta. É a saída para quem perdeu o aparelho: sem isto o
   * cliente fica trancado para fora e a única alternativa seria mexer no banco.
   *
   * Só desliga — quem religa é o próprio titular, em Configurações, porque o
   * segredo precisa ser cadastrado no aplicativo dele.
   */
  @Post(':idPublico/resetar-2fa')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async resetar2fa(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    const step = stepUpSchema.safeParse(body ?? {});
    if (!step.success) throw new BadRequestException(step.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, step.data.codigoTotp);

    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');
    if (!usuario.totpHabilitado) {
      throw new BadRequestException('Esta conta não tem 2FA ativo.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          totpHabilitado: false,
          segredoTotpCriptografado: null,
          totpAtivadoEm: null,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: usuario.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'USUARIO_2FA_RESETADO',
          nomeTabela: 'usuarios',
          chaveRegistro: usuario.id.toString(),
          enderecoIp: req.ip,
          dadosAnteriores: { totpHabilitado: true } as never,
          dadosNovos: { totpHabilitado: false } as never,
        },
      });
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.TOTP_DESABILITADO,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return { ok: true, totpHabilitado: false };
  }

  /**
   * Gera uma senha provisória e obriga a troca no próximo login.
   *
   * A senha volta UMA vez na resposta para o administrador repassar pelo canal
   * dele — não fica guardada em lugar nenhum em texto claro. `forcarTrocaSenha`
   * é o que impede a provisória de virar a senha definitiva: o login não emite
   * token enquanto ela não for trocada.
   */
  @Post(':idPublico/resetar-senha')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async resetarSenha(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    const step = stepUpSchema.safeParse(body ?? {});
    if (!step.success) throw new BadRequestException(step.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, step.data.codigoTotp);

    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const senhaProvisoria = gerarSenhaProvisoria();
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          senhaHash: await argon2.hash(senhaProvisoria),
          senhaAlteradaEm: new Date(),
          forcarTrocaSenha: true,
          // Reset de senha destrava a conta travada por tentativas — é o mesmo
          // efeito da redefinição por e-mail.
          contaBloqueada: false,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: usuario.id,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'USUARIO_SENHA_RESETADA',
          nomeTabela: 'usuarios',
          chaveRegistro: usuario.id.toString(),
          enderecoIp: req.ip,
          // A senha NUNCA entra na auditoria.
          dadosNovos: { forcarTrocaSenha: true } as never,
        },
      });
    });

    await this.prisma.auditoriaAcesso.create({
      data: {
        usuarioId: usuario.id,
        emailInformado: usuario.email,
        enderecoIp: req.ip,
        sucesso: true,
        motivo: 'SENHA_RESETADA_PELO_ADMIN',
      },
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.SENHA_ALTERADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return {
      ok: true,
      senhaProvisoria,
      aviso:
        'Repasse esta senha ao titular. Ela aparece uma única vez e precisa ser trocada no próximo login.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IPs autorizados das credenciais de API da conta
  // ─────────────────────────────────────────────────────────────────────────

  /** Credenciais ativas da conta com os IPs liberados em cada uma. */
  @Get(':idPublico/ips')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_VER)
  async listarIps(@Param('idPublico') idPublico: string) {
    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');
    const credenciais = await this.prisma.credencialApi.findMany({
      where: { usuarioId: usuario.id, ativo: true, revogadoEm: null },
      include: { ipsPermitidos: { orderBy: { id: 'asc' } } },
      orderBy: { criadoEm: 'desc' },
    });
    return credenciais.map((c) => ({
      id: c.id.toString(),
      nome: c.nome,
      chavePublica: c.chavePublica,
      ips: c.ipsPermitidos.map((i) => ({ id: i.id.toString(), ip: i.ipOuCidr })),
    }));
  }

  @Post(':idPublico/ips')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async adicionarIp(
    @Param('idPublico') idPublico: string,
    @Body() body: { credencialId?: string; ip?: string; codigoTotp?: string },
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const { usuario, credencial } = await this.credencialDaConta(
      idPublico,
      body.credencialId,
    );
    const ip = normalizarIpOuCidr(String(body.ip ?? ''));
    if (!ip) {
      throw new BadRequestException(
        `IP ou faixa inválida: "${body.ip ?? ''}" (ex.: 203.0.113.10, 198.51.100.0/24).`,
      );
    }
    const jaExiste = await this.prisma.ipPermitidoApi.findFirst({
      where: { credencialApiId: credencial.id, ipOuCidr: ip },
    });
    if (jaExiste) throw new BadRequestException('Este IP já está liberado nesta chave.');

    await this.prisma.ipPermitidoApi.create({
      data: { credencialApiId: credencial.id, ipOuCidr: ip },
    });
    await this.auditarIp(usuario.id, credencial.id, req, 'USUARIO_IP_API_ADICIONADO', ip);
    return { ok: true, ip };
  }

  @Delete(':idPublico/ips/:ipId')
  @RequerPermissao(PERMISSOES.ADMIN_USUARIOS_EDITAR)
  async removerIp(
    @Param('idPublico') idPublico: string,
    @Param('ipId') ipId: string,
    @Req() req: { user: { id: string }; ip?: string },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    // O IP precisa pertencer a uma credencial DESTA conta — sem esta conferência
    // o id na URL apagaria allowlist de qualquer cliente.
    const registro = await this.prisma.ipPermitidoApi.findFirst({
      where: { id: BigInt(ipId), credencial: { usuarioId: usuario.id } },
      include: { credencial: true },
    });
    if (!registro) throw new NotFoundException('IP não encontrado nesta conta');

    await this.prisma.ipPermitidoApi.delete({ where: { id: registro.id } });
    await this.auditarIp(
      usuario.id,
      registro.credencialApiId,
      req,
      'USUARIO_IP_API_REMOVIDO',
      registro.ipOuCidr,
    );
    return { ok: true };
  }

  private async credencialDaConta(idPublico: string, credencialId?: string) {
    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');
    if (!credencialId) throw new BadRequestException('Informe a chave de API.');
    const credencial = await this.prisma.credencialApi.findFirst({
      where: {
        id: BigInt(credencialId),
        usuarioId: usuario.id,
        ativo: true,
        revogadoEm: null,
      },
    });
    if (!credencial) {
      throw new NotFoundException('Chave de API não encontrada nesta conta');
    }
    return { usuario, credencial };
  }

  private auditarIp(
    usuarioId: bigint,
    credencialId: bigint,
    req: { user: { id: string }; ip?: string },
    acao: string,
    ip: string,
  ) {
    return this.prisma.registroAuditoria.create({
      data: {
        usuarioAfetadoId: usuarioId,
        usuarioAtorId: BigInt(req.user.id),
        credencialApiId: credencialId,
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao,
        nomeTabela: 'ips_permitidos_api',
        chaveRegistro: credencialId.toString(),
        enderecoIp: req.ip,
        dadosNovos: { ip } as never,
      },
    });
  }
}

/** Teto de prazo: 365 dias. Acima disso é erro de digitação, não regra. */
const MAXIMO_DIAS = 365;
const ORIGENS_SAQUE: string[] = ['PAINEL', 'API', 'AMBOS'];

/**
 * Saldo negativo permitido = o que está gravado OU o modo de MED exigir.
 *
 * Débito direto de MED só funciona com a conta podendo ficar negativa, então a
 * regra é aplicada na LEITURA também — linha gravada antes desta regra existir
 * (débito direto com a flag desligada) não pode mostrar "desmarcado" na tela nem
 * fazer o job de MED falhar por saldo insuficiente.
 */
function permiteNegativo(gravado: boolean, modo: string | undefined): boolean {
  return gravado || modo === MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE;
}

/**
 * Condições comerciais que existem nas DUAS tabelas — `configuracoes_pix_usuarios`
 * (o cliente) e `configuracoes_padrao_pix_usuarios` (o padrão de novos clientes).
 *
 * Uma função só porque o padrão vira configuração de cliente na ativação: validar
 * em lugares diferentes deixaria o padrão gravar um valor que a tela do cliente
 * recusa, e o erro só apareceria na primeira venda da conta nova.
 */
function regrasComerciais(body: Record<string, string>) {
  const numero = (v: unknown, campo: string, maximo?: number) => {
    const n = Number(v);
    if (!isFinite(n) || n < 0) throw new BadRequestException(`${campo} inválido`);
    if (maximo !== undefined && n > maximo) {
      throw new BadRequestException(`${campo}: máximo é ${maximo}`);
    }
    return n;
  };
  const inteiro = (v: unknown, campo: string, maximo: number) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequestException(`${campo} inválido`);
    }
    if (n > maximo) throw new BadRequestException(`${campo}: máximo é ${maximo}`);
    return n;
  };

  const ticketMaximoPixEntrada = numero(
    body.ticketMaximoPixEntrada,
    'ticketMaximoPixEntrada',
  );
  const ticketMinimoPixEntrada = numero(
    body.ticketMinimoPixEntrada,
    'ticketMinimoPixEntrada',
  );
  if (ticketMaximoPixEntrada <= 0) {
    throw new BadRequestException('Valor máximo de PIX in precisa ser maior que zero.');
  }
  if (ticketMinimoPixEntrada > ticketMaximoPixEntrada) {
    throw new BadRequestException(
      'Valor mínimo de PIX in não pode ser maior que o máximo.',
    );
  }

  // Ticket de saída: a ficha do cliente envia; o modal do padrão ainda não.
  // Ausente no corpo → não entra no retorno (Prisma não sobrescreve a coluna).
  const editaTicketSaida =
    body.ticketMinimoPixSaida !== undefined ||
    body.ticketMaximoPixSaida !== undefined;
  let ticketMinimoPixSaida: number | undefined;
  let ticketMaximoPixSaida: number | null | undefined;
  if (editaTicketSaida) {
    ticketMinimoPixSaida = numero(
      body.ticketMinimoPixSaida ?? '0',
      'ticketMinimoPixSaida',
    );
    // String vazia = sem teto (coluna nullable).
    if (!body.ticketMaximoPixSaida) {
      ticketMaximoPixSaida = null;
    } else {
      ticketMaximoPixSaida = numero(
        body.ticketMaximoPixSaida,
        'ticketMaximoPixSaida',
      );
      if (ticketMaximoPixSaida <= 0) {
        throw new BadRequestException(
          'Valor máximo de PIX out precisa ser maior que zero (ou vazio para sem teto).',
        );
      }
      if (ticketMinimoPixSaida > ticketMaximoPixSaida) {
        throw new BadRequestException(
          'Valor mínimo de PIX out não pode ser maior que o máximo.',
        );
      }
    }
  }

  // Limite diário / velocity: string vazia = sem teto (null).
  const editaLimitesVelocity =
    body.limiteDiarioPixSaida !== undefined ||
    body.maxSaquesPorHora !== undefined;
  let limiteDiarioPixSaida: number | null | undefined;
  let maxSaquesPorHora: number | null | undefined;
  if (editaLimitesVelocity) {
    if (!body.limiteDiarioPixSaida) {
      limiteDiarioPixSaida = null;
    } else {
      limiteDiarioPixSaida = numero(
        body.limiteDiarioPixSaida,
        'limiteDiarioPixSaida',
      );
      if (limiteDiarioPixSaida <= 0) {
        throw new BadRequestException(
          'Limite diário de saque precisa ser maior que zero (ou vazio para sem teto).',
        );
      }
    }
    if (!body.maxSaquesPorHora) {
      maxSaquesPorHora = null;
    } else {
      maxSaquesPorHora = inteiro(body.maxSaquesPorHora, 'maxSaquesPorHora', 1000);
      if (maxSaquesPorHora <= 0) {
        throw new BadRequestException(
          'Máximo de saques/hora precisa ser maior que zero (ou vazio para sem teto).',
        );
      }
    }
  }

  if (body.origemSaquePermitida && !ORIGENS_SAQUE.includes(body.origemSaquePermitida)) {
    throw new BadRequestException('origemSaquePermitida inválida');
  }
  // Sem default: um corpo que "esquece" o modo de MED ou a base da reserva
  // reescreveria regra de dinheiro sem ninguém ter pedido. Ausente → 400.
  const baseCalculoReserva = body.baseCalculoReserva;
  if (!(Object.values(BASE_CALCULO_RESERVA) as string[]).includes(baseCalculoReserva)) {
    throw new BadRequestException('baseCalculoReserva inválida');
  }
  const modoTratamentoMed = body.modoTratamentoMed;
  if (!(Object.values(MODO_TRATAMENTO_MED) as string[]).includes(modoTratamentoMed)) {
    throw new BadRequestException('modoTratamentoMed inválido');
  }

  return {
    taxaPixEntradaPercentual: numero(
      body.taxaPixEntradaPercentual,
      'taxaPixEntradaPercentual',
      100,
    ),
    taxaPixEntradaFixa: numero(body.taxaPixEntradaFixa, 'taxaPixEntradaFixa'),
    taxaPixSaidaPercentual: numero(
      body.taxaPixSaidaPercentual,
      'taxaPixSaidaPercentual',
      100,
    ),
    taxaPixSaidaFixa: numero(body.taxaPixSaidaFixa, 'taxaPixSaidaFixa'),
    ticketMinimoPixEntrada,
    ticketMaximoPixEntrada,
    ...(editaTicketSaida
      ? { ticketMinimoPixSaida, ticketMaximoPixSaida }
      : {}),
    ...(editaLimitesVelocity
      ? { limiteDiarioPixSaida, maxSaquesPorHora }
      : {}),
    // D+N: quantos dias a venda paga fica em "a liberar" antes de virar saldo
    // disponível. 0 = cai disponível na hora do pagamento.
    diasLiberacaoSaldo: inteiro(body.diasLiberacaoSaldo, 'diasLiberacaoSaldo', MAXIMO_DIAS),
    // Reserva: % de cada venda retido como garantia e liberado depois do prazo.
    percentualReserva: numero(body.percentualReserva, 'percentualReserva', 100),
    baseCalculoReserva: baseCalculoReserva as never,
    diasRetencaoReserva: inteiro(
      body.diasRetencaoReserva,
      'diasRetencaoReserva',
      MAXIMO_DIAS,
    ),
    modoTratamentoMed: modoTratamentoMed as never,
    /**
     * Débito direto de MED IMPLICA saldo negativo permitido: a adquirente já
     * tirou o dinheiro do nosso lado, então o débito tem que sair mesmo com a
     * conta zerada — senão o job falha e a perda fica só na nossa conta.
     * Por isso o campo é forçado (e a tela mostra marcado e travado) nesse modo.
     * Saque continua exigindo saldo: ver `criarSaque` em `pix.service.ts`.
     */
    permiteSaldoNegativo:
      body.permiteSaldoNegativo === 'true' ||
      modoTratamentoMed === MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE,
    origemSaquePermitida: (body.origemSaquePermitida ?? 'PAINEL') as never,
    // `permitirPixSaidaViaApi` continua espelhando a origem para não deixar
    // dado antigo divergindo do que a tela mostra.
    permitirPixSaidaViaApi:
      body.origemSaquePermitida === 'API' || body.origemSaquePermitida === 'AMBOS',
    exigirChavePixCadastrada: body.exigirChavePixCadastrada !== 'false',
  };
}

/**
 * Senha provisória do reset administrativo: 14 caracteres com letra, número e
 * símbolo, sem `0/O/1/l` para não gerar confusão ao ser ditada por telefone.
 * Passa nas regras de força (`violacoesSenha`) por construção — o embaralhamento
 * é conferido antes de devolver.
 */
function gerarSenhaProvisoria(): string {
  const minusculas = 'abcdefghijkmnopqrstuvwxyz';
  const maiusculas = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const numeros = '23456789';
  const simbolos = '!@#$%&*?';
  const todos = minusculas + maiusculas + numeros + simbolos;
  const sorteia = (alfabeto: string) =>
    alfabeto[randomInt(0, alfabeto.length)];

  for (let tentativa = 0; tentativa < 50; tentativa++) {
    const chars = [
      sorteia(maiusculas),
      sorteia(minusculas),
      sorteia(numeros),
      sorteia(simbolos),
      ...Array.from({ length: 10 }, () => sorteia(todos)),
    ];
    // Embaralha (Fisher-Yates) para os obrigatórios não ficarem sempre no começo.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const senha = chars.join('');
    // O sorteio pode produzir "aaa" ou "123" por acaso — nesse caso, sorteia de novo.
    if (!violacoesSenha(senha).length) return senha;
  }
  throw new BadRequestException('Não foi possível gerar a senha provisória.');
}
