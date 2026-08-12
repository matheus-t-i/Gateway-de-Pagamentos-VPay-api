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
  chavePixValida,
  mensagemChavePixInvalida,
  normalizarChavePixCadastro,
  PERMISSOES,
  SITUACAO_EXECUCAO_SAQUE,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
  TIPOS_CHAVE_PIX,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  JwtAuthGuard,
  temPermissao,
  type UsuarioAutenticado,
} from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { QueuesService } from '../queues/queues.service';
import { getRastreio } from '../common/request-context';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';
import { TesourariaService } from './tesouraria.service';

type UsuarioReq = { user: UsuarioAutenticado; ip?: string };

/** Corpo aceito na criação/edição de gatilho. */
type GatilhoBody = {
  contaProvedorId?: string;
  nome?: string;
  ativo?: boolean;
  ordem?: number | string;
  valorGatilho?: number | string;
  valorReserva?: number | string;
  valorMinimoPayout?: number | string;
  valorMaximoPayout?: number | string | null;
  chavePix?: string;
  tipoChavePix?: string;
  nomeTitular?: string;
  documentoTitular?: string;
  intervaloMinimoMinutos?: number | string;
  codigoTotp?: string;
};

@Controller('admin/tesouraria')
@UseGuards(JwtAuthGuard)
export class AdminTesourariaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tesouraria: TesourariaService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Saldo do gateway em cada adquirente. Por padrão devolve o último snapshot
   * (`saldos_adquirentes`); `?atualizar=1` força a consulta na API da
   * adquirente antes de responder.
   */
  @Get('saldos')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_VER)
  async saldos(@Req() req: UsuarioReq, @Query() q: Record<string, string>) {
    // `atualizar=1` bate na API da adquirente: é ação, não leitura. Quem só tem
    // permissão de ver recebe o último snapshot em vez de um 403.
    if (
      q.atualizar === '1' &&
      temPermissao(req.user, PERMISSOES.ADMIN_TESOURARIA_EXECUTAR)
    ) {
      await this.tesouraria.atualizarTodosSaldos();
    }
    const contas = await this.prisma.contaProvedor.findMany({
      orderBy: [{ provedorPagamentoId: 'asc' }, { id: 'asc' }],
      include: {
        provedor: true,
        saldo: true,
        _count: { select: { gatilhosSaque: true } },
      },
    });
    return contas.map((c) => ({
      contaProvedorId: c.id.toString(),
      conta: c.nome,
      adquirente: c.provedor.nome,
      adquirenteCodigo: c.provedor.codigo,
      situacaoConta: c.situacao,
      situacaoAdquirente: c.provedor.situacao,
      pixSaidaHabilitado: c.pixSaidaHabilitado,
      moeda: c.saldo?.moeda ?? 'BRL',
      saldoDisponivel: c.saldo?.saldoDisponivel?.toString() ?? null,
      saldoBloqueado: c.saldo?.saldoBloqueado?.toString() ?? null,
      consultadoEm: c.saldo?.consultadoEm ?? null,
      erroUltimaConsulta: c.saldo?.erroUltimaConsulta ?? null,
      totalGatilhos: c._count.gatilhosSaque,
    }));
  }

  @Post('saldos/atualizar')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_EXECUTAR)
  async atualizarSaldos(
    @Req() req: UsuarioReq,
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const contas = await this.tesouraria.atualizarTodosSaldos();
    return { ok: true, contas };
  }

  /** Gatilhos de saque automático — paginado + filtros. */
  @Get('gatilhos')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_VER)
  async gatilhos(@Query() q: Record<string, string>) {
    const { pagina, limite } = this.paginacao(q);

    const where: Record<string, unknown> = {};
    if (q.adquirente) where.contaProvedor = { provedor: { codigo: q.adquirente } };
    if (q.ativo === 'true' || q.ativo === 'false') where.ativo = q.ativo === 'true';
    const busca = (q.busca ?? '').trim();
    if (busca) {
      where.OR = [
        { nome: { contains: busca, mode: 'insensitive' } },
        { chavePix: { contains: busca, mode: 'insensitive' } },
        { nomeTitular: { contains: busca, mode: 'insensitive' } },
      ];
    }

    const [total, itens] = await Promise.all([
      this.prisma.gatilhoSaqueAdquirente.count({ where: where as never }),
      this.prisma.gatilhoSaqueAdquirente.findMany({
        where: where as never,
        orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          contaProvedor: { include: { provedor: true, saldo: true } },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((g) => ({
        id: g.idPublico,
        nome: g.nome,
        ativo: g.ativo,
        ordem: g.ordem,
        contaProvedorId: g.contaProvedorId.toString(),
        conta: g.contaProvedor.nome,
        adquirente: g.contaProvedor.provedor.nome,
        adquirenteCodigo: g.contaProvedor.provedor.codigo,
        saldoDisponivel: g.contaProvedor.saldo?.saldoDisponivel?.toString() ?? null,
        valorGatilho: g.valorGatilho.toString(),
        valorReserva: g.valorReserva.toString(),
        valorMinimoPayout: g.valorMinimoPayout.toString(),
        valorMaximoPayout: g.valorMaximoPayout?.toString() ?? null,
        chavePix: g.chavePix,
        tipoChavePix: g.tipoChavePix,
        nomeTitular: g.nomeTitular,
        documentoTitular: g.documentoTitular,
        intervaloMinimoMinutos: g.intervaloMinimoMinutos,
        ultimaExecucaoEm: g.ultimaExecucaoEm,
        criadoEm: g.criadoEm,
      })),
    };
  }

  @Post('gatilhos')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_EDITAR)
  async criarGatilho(@Body() body: GatilhoBody, @Req() req: UsuarioReq) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const dados = await this.validarGatilho(body, { exigirConta: true });
    const criado = await this.prisma.gatilhoSaqueAdquirente.create({
      data: {
        contaProvedorId: BigInt(body.contaProvedorId as string),
        ...dados,
        criadoPorUsuarioId: BigInt(req.user.id),
        atualizadoPorUsuarioId: BigInt(req.user.id),
      },
    });
    await this.auditar(req, 'GATILHO_SAQUE_CRIAR', criado.idPublico, null, dados);
    return { id: criado.idPublico };
  }

  @Put('gatilhos/:id')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_EDITAR)
  async editarGatilho(
    @Param('id') id: string,
    @Body() body: GatilhoBody,
    @Req() req: UsuarioReq,
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const antes = await this.prisma.gatilhoSaqueAdquirente.findUnique({
      where: { idPublico: id },
    });
    if (!antes) throw new BadRequestException('Gatilho não encontrado');
    const dados = await this.validarGatilho(body, { exigirConta: false });
    await this.prisma.gatilhoSaqueAdquirente.update({
      where: { idPublico: id },
      data: { ...dados, atualizadoPorUsuarioId: BigInt(req.user.id) },
    });
    await this.auditar(
      req,
      'GATILHO_SAQUE_EDITAR',
      id,
      {
        nome: antes.nome,
        ativo: antes.ativo,
        valorGatilho: antes.valorGatilho.toString(),
        valorReserva: antes.valorReserva.toString(),
        valorMinimoPayout: antes.valorMinimoPayout.toString(),
        valorMaximoPayout: antes.valorMaximoPayout?.toString() ?? null,
        chavePix: antes.chavePix,
      },
      dados,
    );
    return { ok: true };
  }

  /**
   * Disparo manual. Reconsulta o saldo e aplica as MESMAS regras do automático
   * — o botão não é um atalho para sacar fora da política configurada.
   */
  @Post('gatilhos/:id/executar')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_EXECUTAR)
  async executarGatilho(
    @Param('id') id: string,
    @Req() req: UsuarioReq,
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const gatilho = await this.prisma.gatilhoSaqueAdquirente.findUnique({
      where: { idPublico: id },
    });
    if (!gatilho) throw new BadRequestException('Gatilho não encontrado');

    const { execucaoId, valorSolicitado } = await this.tesouraria.dispararManual(
      gatilho.id,
      BigInt(req.user.id),
    );
    // O envio à adquirente vai para a fila: request de painel não espera I/O
    // externo e a retentativa do BullMQ cobre indisponibilidade.
    await this.queues.enqueueSaqueAutomatico({
      execucaoId,
      identificadorRastreio: getRastreio(),
    });
    await this.auditar(req, 'GATILHO_SAQUE_EXECUTAR', id, null, { valorSolicitado });
    return { ok: true, valorSolicitado };
  }

  /** Histórico de disparos — paginado + filtros. */
  @Get('execucoes')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_VER)
  async execucoes(@Query() q: Record<string, string>) {
    const { pagina, limite } = this.paginacao(q);

    const where: Record<string, unknown> = {};
    if (q.situacao) where.situacao = q.situacao;
    if (q.origem) where.origem = q.origem;
    if (q.gatilho) where.gatilho = { idPublico: q.gatilho };
    if (q.adquirente) where.contaProvedor = { provedor: { codigo: q.adquirente } };
    if (q.dataInicial || q.dataFinal) {
      const gte = q.dataInicial ? new Date(q.dataInicial + 'T00:00:00') : undefined;
      const lte = q.dataFinal ? new Date(q.dataFinal + 'T23:59:59.999') : undefined;
      where.criadoEm = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }

    const [total, itens] = await Promise.all([
      this.prisma.execucaoGatilhoSaque.count({ where: where as never }),
      this.prisma.execucaoGatilhoSaque.findMany({
        where: where as never,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          gatilho: true,
          contaProvedor: { include: { provedor: true } },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((e) => ({
        id: e.idPublico,
        criadoEm: e.criadoEm,
        gatilho: e.gatilho.nome,
        gatilhoId: e.gatilho.idPublico,
        adquirente: e.contaProvedor.provedor.nome,
        adquirenteCodigo: e.contaProvedor.provedor.codigo,
        conta: e.contaProvedor.nome,
        origem: e.origem,
        saldoObservado: e.saldoObservado.toString(),
        valorSolicitado: e.valorSolicitado.toString(),
        situacao: e.situacao,
        idTransacaoLiquidante: e.idTransacaoLiquidante,
        mensagemErro: e.mensagemErro,
        concluidoEm: e.concluidoEm,
        chavePix: e.gatilho.chavePix,
        tipoChavePix: e.gatilho.tipoChavePix,
      })),
    };
  }

  /**
   * Acompanhamento de Saques: contagem e volume dos cash-out dos LOJISTAS por
   * situação, mais o resumo das execuções de tesouraria. Alimenta os cards do
   * topo da tela; a tabela detalhada é o relatório de cash-out.
   */
  @Get('saques/resumo')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_VER)
  async resumoSaques(@Query() q: Record<string, string>) {
    const where: Record<string, unknown> = { direcao: 'SAIDA' };
    if (q.dataInicial || q.dataFinal) {
      const gte = q.dataInicial ? new Date(q.dataInicial + 'T00:00:00') : undefined;
      const lte = q.dataFinal ? new Date(q.dataFinal + 'T23:59:59.999') : undefined;
      where.criadoEm = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }
    if (q.adquirente) {
      const contas = await this.prisma.contaProvedor.findMany({
        where: { provedor: { codigo: q.adquirente } },
        select: { id: true },
      });
      where.contaProvedorId = { in: contas.map((c) => c.id) };
    }

    const [porSituacao, execucoes] = await Promise.all([
      this.prisma.transacao.groupBy({
        by: ['situacao'],
        where: where as never,
        _count: { _all: true },
        _sum: { valorBruto: true, valorTarifaPix: true },
      }),
      this.prisma.execucaoGatilhoSaque.groupBy({
        by: ['situacao'],
        _count: { _all: true },
        _sum: { valorSolicitado: true },
      }),
    ]);

    // Devolve TODAS as situações possíveis, inclusive as zeradas — card que
    // some quando não há registro faz a tela "piscar" entre filtros. PENDENTE
    // fica de fora: nenhum saque nasce nele (`criarSaque` grava PROCESSANDO) e
    // a coluna não tem mais default, então seria um card eternamente zerado.
    const situacoesSaque = [
      SITUACAO_TRANSACAO.PROCESSANDO,
      SITUACAO_TRANSACAO.CONCLUIDA,
      SITUACAO_TRANSACAO.FALHA,
      SITUACAO_TRANSACAO.CANCELADA,
    ];
    const mapa = new Map(porSituacao.map((r) => [r.situacao as string, r]));

    return {
      saquesLojistas: situacoesSaque.map((s) => ({
        situacao: s,
        quantidade: mapa.get(s)?._count._all ?? 0,
        valorBruto: mapa.get(s)?._sum.valorBruto?.toString() ?? '0',
        valorTarifa: mapa.get(s)?._sum.valorTarifaPix?.toString() ?? '0',
      })),
      tesouraria: Object.values(SITUACAO_EXECUCAO_SAQUE).map((s) => {
        const r = execucoes.find((e) => e.situacao === s);
        return {
          situacao: s,
          quantidade: r?._count._all ?? 0,
          valor: r?._sum.valorSolicitado?.toString() ?? '0',
        };
      }),
    };
  }

  /** Contas de adquirente elegíveis a gatilho (para o select do modal). */
  @Get('contas')
  @RequerPermissao(PERMISSOES.ADMIN_TESOURARIA_VER)
  async contas() {
    const contas = await this.prisma.contaProvedor.findMany({
      where: { situacao: SITUACAO_PROVEDOR.ATIVO },
      orderBy: [{ provedorPagamentoId: 'asc' }, { id: 'asc' }],
      include: { provedor: true },
    });
    return contas.map((c) => ({
      id: c.id.toString(),
      nome: `${c.provedor.nome} — ${c.nome}`,
      adquirenteCodigo: c.provedor.codigo,
      pixSaidaHabilitado: c.pixSaidaHabilitado,
    }));
  }

  private paginacao(q: Record<string, string>) {
    return {
      pagina: Math.max(1, Number(q.page) || 1),
      limite: Math.min(1000, Math.max(5, Number(q.limit) || 10)),
    };
  }

  /**
   * Valida e normaliza o corpo do gatilho. As mesmas invariantes existem como
   * CHECK no banco; aqui a mensagem é legível para quem está na tela.
   */
  private async validarGatilho(
    body: GatilhoBody,
    opts: { exigirConta: boolean },
  ) {
    if (opts.exigirConta) {
      if (!body.contaProvedorId) {
        throw new BadRequestException('Informe a conta da adquirente.');
      }
      const conta = await this.prisma.contaProvedor.findUnique({
        where: { id: BigInt(body.contaProvedorId) },
        include: { provedor: true },
      });
      if (!conta) throw new BadRequestException('Conta da adquirente não encontrada.');
      if (!conta.pixSaidaHabilitado || !conta.provedor.permitePixSaida) {
        throw new BadRequestException(
          'Esta conta não tem PIX de saída habilitado — não é possível sacar por ela.',
        );
      }
    }

    const nome = (body.nome ?? '').trim();
    if (!nome) throw new BadRequestException('Informe o nome do gatilho.');

    const tipoChavePix = (body.tipoChavePix ?? '').trim().toUpperCase();
    if (!TIPOS_CHAVE_PIX.includes(tipoChavePix as never)) {
      throw new BadRequestException('Tipo de chave PIX inválido.');
    }
    const chavePix = normalizarChavePixCadastro(
      tipoChavePix,
      (body.chavePix ?? '').trim(),
    );
    if (!chavePix) throw new BadRequestException('Informe a chave PIX de destino.');
    if (!chavePixValida(tipoChavePix, chavePix)) {
      throw new BadRequestException(mensagemChavePixInvalida(tipoChavePix));
    }

    const dec = (v: unknown, campo: string) => {
      const n = Number(v ?? 0);
      if (!isFinite(n) || n < 0) throw new BadRequestException(`${campo} inválido.`);
      return n;
    };
    const int = (v: unknown, campo: string, padrao: number) => {
      if (v === undefined || v === null || v === '') return padrao;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new BadRequestException(`${campo} inválido.`);
      return n;
    };

    const valorGatilho = dec(body.valorGatilho, 'Valor de disparo');
    if (valorGatilho <= 0) {
      throw new BadRequestException('O valor de disparo precisa ser maior que zero.');
    }
    const valorMinimoPayout = dec(body.valorMinimoPayout, 'Valor mínimo do saque');
    const valorMaximoPayout =
      body.valorMaximoPayout === undefined ||
      body.valorMaximoPayout === null ||
      body.valorMaximoPayout === ''
        ? null
        : dec(body.valorMaximoPayout, 'Valor máximo do saque');
    if (valorMaximoPayout !== null && valorMaximoPayout < valorMinimoPayout) {
      throw new BadRequestException(
        'O valor máximo do saque não pode ser menor que o mínimo.',
      );
    }
    if (valorMaximoPayout !== null && valorMaximoPayout <= 0) {
      throw new BadRequestException('O valor máximo do saque precisa ser maior que zero.');
    }
    const valorReserva = dec(body.valorReserva, 'Reserva');
    if (valorReserva >= valorGatilho) {
      // Reserva >= disparo nunca sobra nada para sacar: o gatilho ficaria ativo
      // sem nunca executar, e o admin não teria como perceber.
      throw new BadRequestException(
        'A reserva precisa ser menor que o valor de disparo, senão o gatilho nunca saca.',
      );
    }

    return {
      nome,
      ativo: body.ativo ?? true,
      ordem: int(body.ordem, 'Ordem', 0),
      valorGatilho,
      valorReserva,
      valorMinimoPayout,
      valorMaximoPayout,
      chavePix,
      tipoChavePix: tipoChavePix as never,
      nomeTitular: (body.nomeTitular ?? '').trim() || null,
      documentoTitular: (body.documentoTitular ?? '').replace(/\D/g, '') || null,
      intervaloMinimoMinutos: int(body.intervaloMinimoMinutos, 'Intervalo mínimo', 60),
    };
  }

  private async auditar(
    req: UsuarioReq,
    acao: string,
    chave: string,
    antes: unknown,
    depois: unknown,
  ) {
    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: BigInt(req.user.id),
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao,
        nomeTabela: 'gatilhos_saque_adquirente',
        chaveRegistro: chave,
        enderecoIp: req.ip,
        dadosAnteriores: (antes ?? undefined) as never,
        dadosNovos: (depois ?? undefined) as never,
      },
    });
  }
}
