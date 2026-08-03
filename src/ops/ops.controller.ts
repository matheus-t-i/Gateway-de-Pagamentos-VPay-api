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
import {
  configuracaoWebhookSchema,
  EVENTOS_LOJISTA,
  money,
  PAPEIS,
  SITUACAO_EMPRESA,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QueuesService } from '../queues/queues.service';
import { getRastreio } from '../common/request-context';
import { encryptText } from '../common/crypto.util';

/**
 * Rótulo da coluna "Produto" de uma venda. Com vários itens mostra o primeiro
 * e quantos mais existem — a lista completa vai no detalhe expansível.
 * Sem itens (depósito do painel ou cobrança anterior ao modelo de produtos),
 * cai na referência externa.
 */
function resumoProduto(
  itens: Array<{ titulo: string }>,
  referenciaExterna: string | null,
): string {
  if (itens.length === 1) return itens[0].titulo;
  if (itens.length > 1) return `${itens[0].titulo} +${itens.length - 1}`;
  return referenciaExterna ?? '—';
}

@Controller('painel/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksEmpresaController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tipos de evento que o gateway realmente emite. O painel PRECISA usar esta
   * lista: `tiposEvento` é filtro de entrega, então um nome que não existe faz
   * o webhook nunca receber nada — falha silenciosa.
   */
  @Get('eventos')
  eventos() {
    return Object.values(EVENTOS_LOJISTA);
  }

  @Get(':empresaIdPublico')
  async listar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    // Removidos são desativados (soft delete) e não aparecem na listagem.
    const rows = await this.prisma.configuracaoWebhookEmpresa.findMany({
      where: { empresaId: empresa.id, ativo: true },
      orderBy: { id: 'desc' },
    });
    return rows.map((w) => this.mapWebhook(w));
  }

  /** Resposta pública: id como string, sem ids internos (empresaId). */
  private mapWebhook(w: {
    id: bigint;
    nome: string;
    urlDestino: string;
    tiposEvento: unknown;
    nomeHeaderAutenticacao: string | null;
    segredoCriptografado: string | null;
    ativo: boolean;
    criadoEm: Date;
  }) {
    return {
      id: w.id.toString(),
      nome: w.nome,
      urlDestino: w.urlDestino,
      tiposEvento: (w.tiposEvento as string[]) ?? [],
      nomeHeaderAutenticacao: w.nomeHeaderAutenticacao,
      // O valor da credencial nunca volta pela API — só se está configurado.
      temSegredoAutenticacao: !!w.segredoCriptografado,
      ativo: w.ativo,
      criadoEm: w.criadoEm,
    };
  }

  @Post(':empresaIdPublico')
  async criar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
    @Body() body: unknown,
  ) {
    const parsed = configuracaoWebhookSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    const criado = await this.prisma.configuracaoWebhookEmpresa.create({
      data: {
        empresaId: empresa.id,
        nome: parsed.data.nome,
        urlDestino: parsed.data.urlDestino,
        tiposEvento: parsed.data.tiposEvento,
        nomeHeaderAutenticacao: parsed.data.nomeHeaderAutenticacao,
        segredoCriptografado: parsed.data.segredoAutenticacao
          ? encryptText(parsed.data.segredoAutenticacao)
          : null,
        ativo: parsed.data.ativo,
      },
    });
    return this.mapWebhook(criado);
  }

  @Delete(':empresaIdPublico/:id')
  async remover(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Param('id') id: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const empresa = await this.getEmpresa(empresaIdPublico, req.user);
    // Soft delete: entregas_webhook referenciam esta config (histórico de
    // auditoria). Apagar violaria a FK e destruiria o histórico de entregas.
    const r = await this.prisma.configuracaoWebhookEmpresa.updateMany({
      where: { id: BigInt(id), empresaId: empresa.id, ativo: true },
      data: { ativo: false },
    });
    if (r.count === 0) {
      throw new BadRequestException('Webhook não encontrado');
    }
    return { ok: true };
  }

  private async getEmpresa(
    idPublico: string,
    user: { id: string; papeis: string[] },
  ) {
    const empresa = await this.prisma.empresa.findUnique({ where: { idPublico } });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== user.id) {
      throw new BadRequestException('Sem acesso');
    }
    return empresa;
  }
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminOpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  private assertAdmin(papeis: string[]) {
    if (!papeis.includes(PAPEIS.ADMINISTRADOR)) {
      throw new BadRequestException('Somente ADMINISTRADOR');
    }
  }

  @Get('dashboard')
  async dashboard(@Req() req: { user: { papeis: string[] } }) {
    this.assertAdmin(req.user.papeis);
    const [usuarios, empresas, transacoes, volume] = await Promise.all([
      this.prisma.usuario.count(),
      this.prisma.empresa.count({ where: { situacao: SITUACAO_EMPRESA.ATIVA } }),
      this.prisma.transacao.count(),
      this.prisma.transacao.aggregate({
        _sum: { valorBruto: true, valorMargemBruta: true },
        where: { situacao: SITUACAO_TRANSACAO.CONCLUIDA },
      }),
    ]);
    const porDia = await this.prisma.$queryRaw<
      Array<{ dia: Date; volume: string; margem: string; qtd: bigint }>
    >`
      SELECT date_trunc('day', criado_em) AS dia,
             COALESCE(SUM(valor_bruto),0)::text AS volume,
             COALESCE(SUM(valor_margem_bruta),0)::text AS margem,
             COUNT(*)::bigint AS qtd
      FROM transacoes
      WHERE criado_em >= NOW() - INTERVAL '14 days'
      GROUP BY 1
      ORDER BY 1
    `;
    return {
      usuarios,
      empresasAtivas: empresas,
      transacoes,
      volumeBruto: volume._sum.valorBruto?.toString() ?? '0',
      margem: volume._sum.valorMargemBruta?.toString() ?? '0',
      serie: porDia.map((r) => ({
        dia: r.dia,
        volume: r.volume,
        margem: r.margem,
        qtd: Number(r.qtd),
      })),
    };
  }

  /**
   * Relatório "Apuração de Resultado (Lucro × Custo)": confronta a receita
   * efetivamente cobrada do cliente (tarifa persistida na operação) com o custo
   * configurado da adquirente. Usa valores PERSISTIDOS na transação, então
   * mudanças posteriores de config não reescrevem o histórico.
   */
  @Get('relatorios/resultado')
  async relatorioResultado(
    @Req() req: { user: { papeis: string[] } },
    @Query() q: Record<string, string>,
  ) {
    this.assertAdmin(req.user.papeis);
    const hoje = new Date();
    const inicio = q.dataInicial
      ? new Date(q.dataInicial + 'T00:00:00')
      : new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const fim = q.dataFinal
      ? new Date(q.dataFinal + 'T23:59:59.999')
      : new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 23, 59, 59, 999);
    const tipo =
      q.tipo === 'cash-in' || q.tipo === 'cash-out' ? q.tipo : undefined;
    const buscaCliente = (q.cliente ?? '').trim().toLowerCase();
    const filtroAdq = (q.adquirente ?? '').trim();
    const filtroResultado = q.resultado;

    const CONCLUIDA = SITUACAO_TRANSACAO.CONCLUIDA;
    const LIQ = SITUACAO_TRANSACAO.LIQUIDADA;
    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;

    const cond: Array<Record<string, unknown>> = [];
    if (!tipo || tipo === 'cash-in') {
      cond.push({ direcao: 'ENTRADA', situacao: { in: [CONCLUIDA, LIQ] as never } });
      cond.push({ direcao: 'ENTRADA', situacao: AG }); // vendas retidas
    }
    if (!tipo || tipo === 'cash-out') {
      cond.push({ direcao: 'SAIDA', situacao: CONCLUIDA });
    }

    const txs = await this.prisma.transacao.findMany({
      where: { criadoEm: { gte: inicio, lte: fim }, OR: cond as never },
      select: {
        empresaId: true,
        direcao: true,
        situacao: true,
        valorBruto: true,
        valorTarifaPix: true,
        valorCustoPixProvedor: true,
        valorMargemBruta: true,
        contaProvedorId: true,
      },
      take: 200000,
    });

    const empresaIds = [...new Set(txs.map((t) => t.empresaId))];
    const contaIds = [
      ...new Set(txs.map((t) => t.contaProvedorId).filter(Boolean)),
    ] as bigint[];
    const [empresas, contas] = await Promise.all([
      this.prisma.empresa.findMany({
        where: { id: { in: empresaIds } },
        select: {
          id: true,
          idPublico: true,
          razaoSocial: true,
          usuarioProprietario: { select: { nomeRazaoSocial: true, email: true } },
        },
      }),
      this.prisma.contaProvedor.findMany({
        where: { id: { in: contaIds } },
        select: { id: true, provedor: { select: { codigo: true, nome: true } } },
      }),
    ]);
    const empMap = new Map(empresas.map((e) => [e.id.toString(), e]));
    const contaMap = new Map(contas.map((c) => [c.id.toString(), c.provedor]));

    const num = (d: unknown) => Number((d as { toString(): string })?.toString?.() ?? 0);
    const f2 = (n: number) => n.toFixed(2);
    const statusDe = (r: number) =>
      r > 0.0001 ? 'Lucro' : r < -0.0001 ? 'Prejuízo' : 'Neutro';

    type Det = {
      tipo: string;
      adquirente: string;
      operacoes: number;
      volume: number;
      receita: number;
      custo: number;
      resultado: number;
    };
    type Cli = {
      idPublico: string;
      nome: string;
      email: string;
      operacoes: number;
      volume: number;
      receita: number;
      custo: number;
      resultado: number;
      retido: number;
      retidoOps: number;
      custoAusente: boolean;
      adqSet: Set<string>;
      dets: Map<string, Det>;
    };
    const clientes = new Map<string, Cli>();

    for (const t of txs) {
      const emp = empMap.get(t.empresaId.toString());
      if (!emp) continue;
      const nome = emp.razaoSocial ?? emp.usuarioProprietario?.nomeRazaoSocial ?? '';
      const email = emp.usuarioProprietario?.email ?? '';
      if (
        buscaCliente &&
        !(
          nome.toLowerCase().includes(buscaCliente) ||
          email.toLowerCase().includes(buscaCliente) ||
          emp.idPublico.toLowerCase().includes(buscaCliente)
        )
      )
        continue;
      const prov = t.contaProvedorId
        ? contaMap.get(t.contaProvedorId.toString())
        : null;
      const adqCodigo = prov?.codigo ?? '—';
      if (filtroAdq && adqCodigo !== filtroAdq) continue;

      const retida = t.direcao === 'ENTRADA' && t.situacao === AG;
      const volume = num(t.valorBruto);
      const receita = retida ? volume : num(t.valorTarifaPix);
      const custo = retida ? 0 : num(t.valorCustoPixProvedor);
      const resultado = retida ? volume : num(t.valorMargemBruta);
      const tipoLabel = t.direcao === 'ENTRADA' ? 'Cash-in' : 'Cash-out';

      let cli = clientes.get(t.empresaId.toString());
      if (!cli) {
        cli = {
          idPublico: emp.idPublico,
          nome,
          email,
          operacoes: 0,
          volume: 0,
          receita: 0,
          custo: 0,
          resultado: 0,
          retido: 0,
          retidoOps: 0,
          custoAusente: false,
          adqSet: new Set(),
          dets: new Map(),
        };
        clientes.set(t.empresaId.toString(), cli);
      }
      cli.operacoes++;
      cli.volume += volume;
      cli.receita += receita;
      cli.custo += custo;
      cli.resultado += resultado;
      cli.adqSet.add(adqCodigo);
      if (retida) {
        cli.retido += volume;
        cli.retidoOps++;
      } else if (custo === 0) {
        cli.custoAusente = true;
      }
      const dk = `${tipoLabel}|${adqCodigo}`;
      let det = cli.dets.get(dk);
      if (!det) {
        det = {
          tipo: tipoLabel,
          adquirente: adqCodigo,
          operacoes: 0,
          volume: 0,
          receita: 0,
          custo: 0,
          resultado: 0,
        };
        cli.dets.set(dk, det);
      }
      det.operacoes++;
      det.volume += volume;
      det.receita += receita;
      det.custo += custo;
      det.resultado += resultado;
    }

    let lista = [...clientes.values()];
    if (filtroResultado === 'lucro') lista = lista.filter((c) => c.resultado > 0.0001);
    else if (filtroResultado === 'prejuizo')
      lista = lista.filter((c) => c.resultado < -0.0001);
    else if (filtroResultado === 'neutro')
      lista = lista.filter((c) => Math.abs(c.resultado) <= 0.0001);
    lista.sort((a, b) => b.resultado - a.resultado);

    const volumeTotal = lista.reduce((s, c) => s + c.volume, 0);
    const receitaTotal = lista.reduce((s, c) => s + c.receita, 0);
    const custoTotal = lista.reduce((s, c) => s + c.custo, 0);
    const resultadoTotal = receitaTotal - custoTotal;
    const retidasTotal = lista.reduce((s, c) => s + c.retido, 0);
    const retidasOps = lista.reduce((s, c) => s + c.retidoOps, 0);

    return {
      filtros: {
        dataInicial: inicio.toISOString().slice(0, 10),
        dataFinal: fim.toISOString().slice(0, 10),
        tipo: tipo ?? 'todos',
        adquirente: filtroAdq || 'todas',
        resultado: filtroResultado ?? 'todos',
      },
      kpis: {
        volumeProcessado: f2(volumeTotal),
        receitaCobrada: f2(receitaTotal),
        custoAdquirentes: f2(custoTotal),
        resultadoLiquido: f2(resultadoTotal),
        vendasRetidas: f2(retidasTotal),
        vendasRetidasOps: retidasOps,
        margemSobreVolume: f2(volumeTotal > 0 ? (resultadoTotal / volumeTotal) * 100 : 0),
        operacoes: lista.reduce((s, c) => s + c.operacoes, 0),
        clientesLucrativos: lista.filter((c) => c.resultado > 0.0001).length,
        clientesPrejuizo: lista.filter((c) => c.resultado < -0.0001).length,
        clientesNeutros: lista.filter((c) => Math.abs(c.resultado) <= 0.0001).length,
        clientesCustoAusente: lista.filter((c) => c.custoAusente).length,
      },
      clientes: lista.map((c) => ({
        idPublico: c.idPublico,
        nome: c.nome,
        email: c.email,
        operacoes: c.operacoes,
        volume: f2(c.volume),
        receita: f2(c.receita),
        custo: f2(c.custo),
        resultado: f2(c.resultado),
        margem: f2(c.volume > 0 ? (c.resultado / c.volume) * 100 : 0),
        status: statusDe(c.resultado),
        adquirentes: c.adqSet.size,
        retido: f2(c.retido),
        retidoOps: c.retidoOps,
        custoAusente: c.custoAusente,
        detalhes: [...c.dets.values()]
          .map((d) => ({
            tipo: d.tipo,
            adquirente: d.adquirente,
            operacoes: d.operacoes,
            volume: f2(d.volume),
            receita: f2(d.receita),
            custo: f2(d.custo),
            resultado: f2(d.resultado),
            margem: f2(d.volume > 0 ? (d.resultado / d.volume) * 100 : 0),
            taxaCliente: f2(d.volume > 0 ? (d.receita / d.volume) * 100 : 0),
            status: statusDe(d.resultado),
          }))
          .sort((a, b) => Number(b.resultado) - Number(a.resultado)),
      })),
      total: lista.length,
    };
  }

  /**
   * Relatório de transações admin (cross-empresa) para Cash-in (ENTRADA) e
   * Cash-out (SAIDA). Paginação SERVER-SIDE (skip/take + count) — cresce em
   * volume. Filtros por período, cliente, adquirente, situação e busca.
   */
  @Get('relatorios/transacoes')
  async relatorioTransacoes(
    @Req() req: { user: { papeis: string[] } },
    @Query() q: Record<string, string>,
  ) {
    this.assertAdmin(req.user.papeis);
    const direcao = q.direcao === 'SAIDA' ? 'SAIDA' : 'ENTRADA';
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 25));

    const where: Record<string, unknown> = { direcao };
    if (q.dataInicial || q.dataFinal) {
      const gte = q.dataInicial ? new Date(q.dataInicial + 'T00:00:00') : undefined;
      const lte = q.dataFinal ? new Date(q.dataFinal + 'T23:59:59.999') : undefined;
      where.criadoEm = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }
    if (q.situacao) where.situacao = q.situacao;
    const busca = (q.busca ?? '').trim();
    if (busca) {
      // `idTransacaoPublico` é coluna UUID: o Postgres não faz LIKE em uuid e o
      // Prisma recusa `contains` nesse tipo (erro 500). Só compara por igualdade
      // quando a busca É um UUID; caso contrário procura só na referência.
      const ehUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(busca);
      where.OR = [
        ...(ehUuid ? [{ idTransacaoPublico: busca }] : []),
        { referenciaExterna: { contains: busca, mode: 'insensitive' } },
      ];
    }
    const cliente = (q.cliente ?? '').trim();
    if (cliente) {
      const emps = await this.prisma.empresa.findMany({
        where: {
          OR: [
            { razaoSocial: { contains: cliente, mode: 'insensitive' } },
            { usuarioProprietario: { email: { contains: cliente, mode: 'insensitive' } } },
          ],
        },
        select: { id: true },
      });
      where.empresaId = { in: emps.map((e) => e.id) };
    }
    if (q.adquirente) {
      const contas = await this.prisma.contaProvedor.findMany({
        where: { provedor: { codigo: q.adquirente } },
        select: { id: true },
      });
      where.contaProvedorId = { in: contas.map((c) => c.id) };
    }

    const [total, itens] = await Promise.all([
      this.prisma.transacao.count({ where: where as never }),
      this.prisma.transacao.findMany({
        where: where as never,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          pix: true,
          itens: { orderBy: { id: 'asc' } },
          empresa: { select: { razaoSocial: true, idPublico: true } },
          contaProvedor: { select: { provedor: { select: { codigo: true } } } },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((t) => ({
        idTransacao: t.idTransacaoPublico,
        criadoEm: t.criadoEm,
        empresa: t.empresa.razaoSocial,
        cliente: t.pix?.nomePagador ?? '—',
        clienteEmail: t.pix?.emailPagador ?? null,
        // Produto real da venda; `referenciaExterna` é só o fallback das
        // cobranças criadas antes dos itens existirem (e do depósito do painel).
        produto: resumoProduto(t.itens, t.referenciaExterna),
        itens: t.itens.map((i) => ({
          titulo: i.titulo,
          quantidade: i.quantidade,
          valorUnitario: i.valorUnitario.toString(),
          valorTotal: i.valorTotal.toString(),
          tangivel: i.tangivel,
        })),
        valorBruto: t.valorBruto.toString(),
        valorTarifa: t.valorTarifaPix.toString(),
        valorLiquido: t.valorLiquidacaoEmpresa.toString(),
        situacao: t.situacao,
        adquirente: t.contaProvedor?.provedor?.codigo ?? '—',
        beneficiario: t.pix?.nomeBeneficiario ?? null,
        chavePix: t.pix?.chavePix ?? null,
        // endToEnd é o identificador fim-a-fim do PIX, não o txid da cobrança.
        endToEnd: t.pix?.identificadorFimAFim ?? null,
        txid: t.pix?.txid ?? null,
      })),
    };
  }

  /**
   * Auditoria: monitora as persistências do sistema (`registros_auditoria`:
   * quem fez, IP, como era → como ficou) e os acessos (`auditorias_acesso`).
   * Paginação server-side + filtros.
   */
  @Get('auditoria')
  async auditoria(
    @Req() req: { user: { papeis: string[] } },
    @Query() q: Record<string, string>,
  ) {
    this.assertAdmin(req.user.papeis);
    const fonte = q.fonte === 'acesso' ? 'acesso' : 'persistencia';
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 25));
    const skip = (pagina - 1) * limite;
    const periodo = () => {
      const gte = q.dataInicial ? new Date(q.dataInicial + 'T00:00:00') : undefined;
      const lte = q.dataFinal ? new Date(q.dataFinal + 'T23:59:59.999') : undefined;
      return gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : undefined;
    };

    if (fonte === 'acesso') {
      const where: Record<string, unknown> = {};
      const p = periodo();
      if (p) where.ocorridoEm = p;
      if (q.ip) where.enderecoIp = { contains: q.ip };
      if (q.busca) where.emailInformado = { contains: q.busca, mode: 'insensitive' };
      if (q.sucesso === 'true') where.sucesso = true;
      if (q.sucesso === 'false') where.sucesso = false;
      const [total, itens] = await Promise.all([
        this.prisma.auditoriaAcesso.count({ where: where as never }),
        this.prisma.auditoriaAcesso.findMany({
          where: where as never,
          orderBy: { ocorridoEm: 'desc' },
          skip,
          take: limite,
          include: { usuario: { select: { email: true } } },
        }),
      ]);
      return {
        fonte,
        pagina,
        limite,
        total,
        itens: itens.map((a) => ({
          id: a.id.toString(),
          quando: a.ocorridoEm,
          emailInformado: a.emailInformado,
          ip: a.enderecoIp,
          sucesso: a.sucesso,
          motivo: a.motivo,
          usuario: a.usuario?.email ?? null,
        })),
      };
    }

    const where: Record<string, unknown> = {};
    const p = periodo();
    if (p) where.criadoEm = p;
    if (q.acao) where.acao = { contains: q.acao, mode: 'insensitive' };
    if (q.tabela) where.nomeTabela = { contains: q.tabela, mode: 'insensitive' };
    if (q.ip) where.enderecoIp = { contains: q.ip };
    if (q.ator) {
      const us = await this.prisma.usuario.findMany({
        where: {
          OR: [
            { email: { contains: q.ator, mode: 'insensitive' } },
            { nomeRazaoSocial: { contains: q.ator, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      where.usuarioAtorId = { in: us.map((u) => u.id) };
    }

    const [total, itens] = await Promise.all([
      this.prisma.registroAuditoria.count({ where: where as never }),
      this.prisma.registroAuditoria.findMany({
        where: where as never,
        orderBy: { criadoEm: 'desc' },
        skip,
        take: limite,
      }),
    ]);
    const atorIds = [
      ...new Set(itens.map((i) => i.usuarioAtorId).filter(Boolean)),
    ] as bigint[];
    const atores = await this.prisma.usuario.findMany({
      where: { id: { in: atorIds } },
      select: { id: true, email: true, nomeRazaoSocial: true },
    });
    const atorMap = new Map(atores.map((a) => [a.id.toString(), a]));

    return {
      fonte,
      pagina,
      limite,
      total,
      itens: itens.map((r) => {
        const a = r.usuarioAtorId ? atorMap.get(r.usuarioAtorId.toString()) : null;
        return {
          id: r.id.toString(),
          quando: r.criadoEm,
          ator: a ? a.email : r.usuarioAtorId ? `usuário ${r.usuarioAtorId}` : 'sistema',
          origem: r.origem,
          operacao: r.operacao,
          acao: r.acao,
          tabela: r.nomeTabela,
          chave: r.chaveRegistro,
          ip: r.enderecoIp,
          metodo: r.metodoHttp,
          caminho: r.caminhoRequisicao,
          sucesso: r.sucesso,
          antes: r.dadosAnteriores,
          depois: r.dadosNovos,
          campos: r.camposAlterados,
        };
      }),
    };
  }

  @Get('provedores')
  async provedores(@Req() req: { user: { papeis: string[] } }) {
    this.assertAdmin(req.user.papeis);
    const rows = await this.prisma.provedorPagamento.findMany({
      include: { ipsWebhook: true },
    });
    // Nunca devolver contas/credenciais nem hash de segredo de webhook.
    return rows.map((p) => ({
      codigo: p.codigo,
      nome: p.nome,
      situacao: p.situacao,
      permitePixEntrada: p.permitePixEntrada,
      permitePixSaida: p.permitePixSaida,
      exigeAssinaturaWebhook: p.exigeAssinaturaWebhook,
      ipsWebhook: p.ipsWebhook.map((i) => i.ipOuCidr),
    }));
  }

  @Put('provedores/:codigo/situacao')
  async situacaoProvedor(
    @Param('codigo') codigo: string,
    @Body() body: { situacao: 'ATIVO' | 'INATIVO' | 'SUSPENSO' },
    @Req() req: { user: { papeis: string[] } },
  ) {
    this.assertAdmin(req.user.papeis);
    const situacoesValidas: string[] = [
      SITUACAO_PROVEDOR.ATIVO,
      SITUACAO_PROVEDOR.INATIVO,
      SITUACAO_PROVEDOR.SUSPENSO,
    ];
    if (!situacoesValidas.includes(body?.situacao)) {
      throw new BadRequestException('situacao inválida');
    }
    const p = await this.prisma.provedorPagamento.update({
      where: { codigo },
      data: { situacao: body.situacao },
    });
    return { codigo: p.codigo, nome: p.nome, situacao: p.situacao };
  }

  /**
   * Alternância EM MASSA de adquirente: troca a conta de roteamento de TODOS os
   * clientes (config por usuário + overrides por empresa + padrão do sistema)
   * para uma adquirente escolhida, por direção (cash-in e/ou cash-out).
   */
  @Post('adquirentes/alternar-massa')
  async alternarAdquirenteMassa(
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
    @Body() body: { adquirenteCodigo?: string; cashIn?: boolean; cashOut?: boolean },
  ) {
    this.assertAdmin(req.user.papeis);
    const codigo = (body?.adquirenteCodigo ?? '').trim();
    if (!codigo) throw new BadRequestException('Informe a adquirente destino.');
    if (!body.cashIn && !body.cashOut) {
      throw new BadRequestException('Selecione cash-in e/ou cash-out.');
    }

    const acharConta = (direcao: 'entrada' | 'saida') =>
      this.prisma.contaProvedor.findFirst({
        where: {
          provedor: { codigo },
          situacao: SITUACAO_PROVEDOR.ATIVO,
          ...(direcao === 'entrada'
            ? { pixEntradaHabilitado: true }
            : { pixSaidaHabilitado: true }),
        },
        orderBy: { id: 'asc' },
      });

    const contaEntrada = body.cashIn ? await acharConta('entrada') : null;
    const contaSaida = body.cashOut ? await acharConta('saida') : null;
    if (body.cashIn && !contaEntrada) {
      throw new BadRequestException(
        `Adquirente ${codigo} não tem conta ativa habilitada para cash-in.`,
      );
    }
    if (body.cashOut && !contaSaida) {
      throw new BadRequestException(
        `Adquirente ${codigo} não tem conta ativa habilitada para cash-out.`,
      );
    }

    const afetados = { usuarios: 0, empresas: 0, padrao: 0 };
    await this.prisma.$transaction(async (tx) => {
      if (contaEntrada) {
        afetados.usuarios += (
          await tx.configuracaoPixUsuario.updateMany({
            data: { contaProvedorPixEntradaId: contaEntrada.id },
          })
        ).count;
        afetados.empresas += (
          await tx.configuracaoPixEmpresa.updateMany({
            where: { contaProvedorPixEntradaId: { not: null } },
            data: { contaProvedorPixEntradaId: contaEntrada.id },
          })
        ).count;
        afetados.padrao += (
          await tx.configuracaoPadraoPixUsuario.updateMany({
            where: { padraoSistema: true },
            data: { contaProvedorPixEntradaId: contaEntrada.id },
          })
        ).count;
      }
      if (contaSaida) {
        await tx.configuracaoPixUsuario.updateMany({
          data: { contaProvedorPixSaidaId: contaSaida.id },
        });
        await tx.configuracaoPixEmpresa.updateMany({
          where: { contaProvedorPixSaidaId: { not: null } },
          data: { contaProvedorPixSaidaId: contaSaida.id },
        });
        await tx.configuracaoPadraoPixUsuario.updateMany({
          where: { padraoSistema: true },
          data: { contaProvedorPixSaidaId: contaSaida.id },
        });
      }
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'ALTERNAR_ADQUIRENTE_MASSA',
          nomeTabela: 'configuracoes_pix',
          enderecoIp: req.ip,
          dadosNovos: {
            adquirente: codigo,
            cashIn: !!body.cashIn,
            cashOut: !!body.cashOut,
            contaEntradaId: contaEntrada?.id.toString() ?? null,
            contaSaidaId: contaSaida?.id.toString() ?? null,
          },
        },
      });
    });

    return {
      ok: true,
      adquirente: codigo,
      cashIn: !!body.cashIn,
      cashOut: !!body.cashOut,
      configuracoesUsuarioAtualizadas: afetados.usuarios,
      overridesEmpresaAtualizados: afetados.empresas,
      padraoAtualizado: afetados.padrao > 0,
    };
  }

  /** Detalhe de uma adquirente: informações + contas com custo configurado. */
  @Get('adquirentes/:codigo')
  async adquirenteDetalhe(
    @Param('codigo') codigo: string,
    @Req() req: { user: { papeis: string[] } },
  ) {
    this.assertAdmin(req.user.papeis);
    const p = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
      include: { contas: { include: { custoPix: true }, orderBy: { id: 'asc' } } },
    });
    if (!p) throw new BadRequestException('Adquirente não encontrada');
    return {
      codigo: p.codigo,
      nome: p.nome,
      situacao: p.situacao,
      permitePixEntrada: p.permitePixEntrada,
      permitePixSaida: p.permitePixSaida,
      exigeAssinaturaWebhook: p.exigeAssinaturaWebhook,
      contas: p.contas.map((c) => ({
        id: c.id.toString(),
        nome: c.nome,
        situacao: c.situacao,
        pixEntradaHabilitado: c.pixEntradaHabilitado,
        pixSaidaHabilitado: c.pixSaidaHabilitado,
        custo: {
          custoPixEntradaPercentual: (c.custoPix?.custoPixEntradaPercentual ?? 0).toString(),
          custoPixEntradaFixo: (c.custoPix?.custoPixEntradaFixo ?? 0).toString(),
          custoPixSaidaPercentual: (c.custoPix?.custoPixSaidaPercentual ?? 0).toString(),
          custoPixSaidaFixo: (c.custoPix?.custoPixSaidaFixo ?? 0).toString(),
        },
      })),
    };
  }

  /** Edita informações da adquirente (nome/flags). */
  @Put('adquirentes/:codigo')
  async editarAdquirente(
    @Param('codigo') codigo: string,
    @Body()
    body: {
      nome?: string;
      permitePixEntrada?: boolean;
      permitePixSaida?: boolean;
      exigeAssinaturaWebhook?: boolean;
    },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const antes = await this.prisma.provedorPagamento.findUnique({ where: { codigo } });
    if (!antes) throw new BadRequestException('Adquirente não encontrada');
    const p = await this.prisma.provedorPagamento.update({
      where: { codigo },
      data: {
        nome: body.nome?.trim() || undefined,
        permitePixEntrada: body.permitePixEntrada,
        permitePixSaida: body.permitePixSaida,
        exigeAssinaturaWebhook: body.exigeAssinaturaWebhook,
      },
    });
    await this.auditar(req, 'ADQUIRENTE_EDITAR', 'provedores_pagamento', codigo, {
      nome: antes.nome,
      permitePixEntrada: antes.permitePixEntrada,
      permitePixSaida: antes.permitePixSaida,
    }, {
      nome: p.nome,
      permitePixEntrada: p.permitePixEntrada,
      permitePixSaida: p.permitePixSaida,
    });
    return { codigo: p.codigo, nome: p.nome };
  }

  /** Edita o CUSTO (o que a adquirente cobra de nós) de uma conta. */
  @Put('adquirentes/contas/:contaId/custo')
  async editarCustoConta(
    @Param('contaId') contaId: string,
    @Body()
    body: {
      custoPixEntradaPercentual?: number | string;
      custoPixEntradaFixo?: number | string;
      custoPixSaidaPercentual?: number | string;
      custoPixSaidaFixo?: number | string;
    },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const id = BigInt(contaId);
    const conta = await this.prisma.contaProvedor.findUnique({ where: { id } });
    if (!conta) throw new BadRequestException('Conta não encontrada');
    const dec = (v: unknown, campo: string) => {
      const n = Number(v ?? 0);
      if (!isFinite(n) || n < 0) throw new BadRequestException(`${campo} inválido`);
      return n;
    };
    const dados = {
      custoPixEntradaPercentual: dec(body.custoPixEntradaPercentual, 'custoPixEntradaPercentual'),
      custoPixEntradaFixo: dec(body.custoPixEntradaFixo, 'custoPixEntradaFixo'),
      custoPixSaidaPercentual: dec(body.custoPixSaidaPercentual, 'custoPixSaidaPercentual'),
      custoPixSaidaFixo: dec(body.custoPixSaidaFixo, 'custoPixSaidaFixo'),
    };
    const antes = await this.prisma.custoPixContaProvedor.findUnique({
      where: { contaProvedorId: id },
    });
    await this.prisma.custoPixContaProvedor.upsert({
      where: { contaProvedorId: id },
      create: { contaProvedorId: id, ...dados, atualizadoPorUsuarioId: BigInt(req.user.id) },
      update: { ...dados, atualizadoPorUsuarioId: BigInt(req.user.id) },
    });
    await this.auditar(
      req,
      'ADQUIRENTE_CUSTO_EDITAR',
      'custos_pix_contas_provedor',
      contaId,
      antes
        ? {
            custoPixEntradaPercentual: antes.custoPixEntradaPercentual.toString(),
            custoPixEntradaFixo: antes.custoPixEntradaFixo.toString(),
            custoPixSaidaPercentual: antes.custoPixSaidaPercentual.toString(),
            custoPixSaidaFixo: antes.custoPixSaidaFixo.toString(),
          }
        : null,
      dados,
    );
    return { ok: true };
  }

  /** Taxa padrão do sistema (o que o gateway cobra dos lojistas por padrão). */
  @Get('taxa-padrao')
  async taxaPadrao(@Req() req: { user: { papeis: string[] } }) {
    this.assertAdmin(req.user.papeis);
    const c = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true },
    });
    if (!c) throw new BadRequestException('Configuração padrão do sistema não encontrada');
    return {
      taxaPixEntradaPercentual: c.taxaPixEntradaPercentual.toString(),
      taxaPixEntradaFixa: c.taxaPixEntradaFixa.toString(),
      taxaPixSaidaPercentual: c.taxaPixSaidaPercentual.toString(),
      taxaPixSaidaFixa: c.taxaPixSaidaFixa.toString(),
      ticketMinimoPixEntrada: c.ticketMinimoPixEntrada.toString(),
      ticketMaximoPixEntrada: c.ticketMaximoPixEntrada.toString(),
      diasLiberacaoSaldo: c.diasLiberacaoSaldo,
      percentualReserva: c.percentualReserva.toString(),
      diasRetencaoReserva: c.diasRetencaoReserva,
    };
  }

  @Put('taxa-padrao')
  async editarTaxaPadrao(
    @Body() body: Record<string, number | string>,
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const c = await this.prisma.configuracaoPadraoPixUsuario.findFirst({
      where: { padraoSistema: true },
    });
    if (!c) throw new BadRequestException('Configuração padrão não encontrada');
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
    const antes = {
      taxaPixEntradaPercentual: c.taxaPixEntradaPercentual.toString(),
      taxaPixEntradaFixa: c.taxaPixEntradaFixa.toString(),
      taxaPixSaidaPercentual: c.taxaPixSaidaPercentual.toString(),
      taxaPixSaidaFixa: c.taxaPixSaidaFixa.toString(),
    };
    await this.prisma.configuracaoPadraoPixUsuario.update({
      where: { id: c.id },
      data: {
        taxaPixEntradaPercentual: dec(body.taxaPixEntradaPercentual, 'taxaPixEntradaPercentual'),
        taxaPixEntradaFixa: dec(body.taxaPixEntradaFixa, 'taxaPixEntradaFixa'),
        taxaPixSaidaPercentual: dec(body.taxaPixSaidaPercentual, 'taxaPixSaidaPercentual'),
        taxaPixSaidaFixa: dec(body.taxaPixSaidaFixa, 'taxaPixSaidaFixa'),
        ticketMinimoPixEntrada: dec(body.ticketMinimoPixEntrada, 'ticketMinimoPixEntrada'),
        ticketMaximoPixEntrada: dec(body.ticketMaximoPixEntrada, 'ticketMaximoPixEntrada'),
        diasLiberacaoSaldo: int(body.diasLiberacaoSaldo, 'diasLiberacaoSaldo'),
        percentualReserva: dec(body.percentualReserva, 'percentualReserva'),
        diasRetencaoReserva: int(body.diasRetencaoReserva, 'diasRetencaoReserva'),
      },
    });
    await this.auditar(req, 'TAXA_PADRAO_EDITAR', 'configuracoes_padrao_pix_usuarios', c.id.toString(), antes, {
      taxaPixEntradaPercentual: String(body.taxaPixEntradaPercentual),
      taxaPixEntradaFixa: String(body.taxaPixEntradaFixa),
      taxaPixSaidaPercentual: String(body.taxaPixSaidaPercentual),
      taxaPixSaidaFixa: String(body.taxaPixSaidaFixa),
    });
    return { ok: true };
  }

  /** Cadastro de nova adquirente (nasce INATIVA; conta/credenciais depois). */
  @Post('adquirentes')
  async criarAdquirente(
    @Body()
    body: { codigo?: string; nome?: string; permitePixEntrada?: boolean; permitePixSaida?: boolean },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    this.assertAdmin(req.user.papeis);
    const codigo = (body.codigo ?? '').trim().toLowerCase();
    const nome = (body.nome ?? '').trim();
    if (!/^[a-z0-9_]{2,50}$/.test(codigo)) {
      throw new BadRequestException('Código inválido (a-z, 0-9, _; 2 a 50 caracteres).');
    }
    if (!nome) throw new BadRequestException('Informe o nome da adquirente.');
    const existe = await this.prisma.provedorPagamento.findUnique({ where: { codigo } });
    if (existe) throw new BadRequestException('Já existe uma adquirente com esse código.');
    const p = await this.prisma.provedorPagamento.create({
      data: {
        codigo,
        nome,
        situacao: SITUACAO_PROVEDOR.INATIVO,
        permitePixEntrada: body.permitePixEntrada ?? false,
        permitePixSaida: body.permitePixSaida ?? false,
      },
    });
    await this.auditar(req, 'ADQUIRENTE_CADASTRAR', 'provedores_pagamento', codigo, null, {
      codigo: p.codigo,
      nome: p.nome,
    });
    return { codigo: p.codigo, nome: p.nome, situacao: p.situacao };
  }

  /** Helper de auditoria para as ações de negócio deste controller. */
  private async auditar(
    req: { user: { id: string }; ip?: string },
    acao: string,
    tabela: string,
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
        nomeTabela: tabela,
        chaveRegistro: chave,
        enderecoIp: req.ip,
        dadosAnteriores: (antes ?? undefined) as never,
        dadosNovos: (depois ?? undefined) as never,
      },
    });
  }

  @Post('webhooks/:entregaId/reenviar')
  async reenviar(
    @Param('entregaId') entregaId: string,
    @Req() req: { user: { papeis: string[] } },
  ) {
    this.assertAdmin(req.user.papeis);
    const entrega = await this.prisma.entregaWebhook.findUnique({
      where: { id: BigInt(entregaId) },
      include: { eventoOutbox: true },
    });
    if (!entrega) throw new BadRequestException('Entrega não encontrada');
    await this.queues.enqueuePixWebhookSend({
      provider: 'system',
      payload: {
        tipoEvento: entrega.eventoOutbox.tipoEvento,
        idPublico: entrega.eventoOutbox.identificadorAgregado,
        empresaId: entrega.empresaId.toString(),
        eventoOutboxId: entrega.eventoOutboxId.toString(),
      },
      identificadorRastreio: getRastreio(),
    });
    return { ok: true };
  }
}

/** Situações que contam como venda "aprovada" (dinheiro que entrou). */
const SITUACOES_APROVADAS: string[] = [
  SITUACAO_TRANSACAO.LIQUIDADA,
  SITUACAO_TRANSACAO.CONCLUIDA,
];

/** Converte `?range=` na janela + granularidade do gráfico. */
function resolverJanela(range?: string): {
  range: string;
  desde: Date;
  porHora: boolean;
} {
  const agora = Date.now();
  const dia = 24 * 60 * 60 * 1000;
  switch (range) {
    case '30d':
      return { range: '30d', desde: new Date(agora - 30 * dia), porHora: false };
    case '7d':
      return { range: '7d', desde: new Date(agora - 7 * dia), porHora: false };
    case 'mes': {
      const d = new Date();
      return {
        range: 'mes',
        desde: new Date(d.getFullYear(), d.getMonth(), 1),
        porHora: false,
      };
    }
    default:
      // 1 dia: últimas 24h por hora.
      return { range: '1d', desde: new Date(agora - dia), porHora: true };
  }
}

@Controller('painel/dashboard')
@UseGuards(JwtAuthGuard)
export class PainelDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async meu(
    @Req() req: { user: { id: string } },
    @Query('range') range?: string,
  ) {
    const empresas = await this.prisma.empresa.findMany({
      where: { usuarioProprietarioId: BigInt(req.user.id) },
      include: { saldo: true },
    });
    const empresaIds = empresas.map((e) => e.id);
    const janela = resolverJanela(range);

    const saldoDisponivel = empresas
      .reduce((acc, e) => acc + Number(e.saldo?.saldoDisponivel ?? 0), 0)
      .toFixed(2);
    const bloqueadoMed = empresas
      .reduce((acc, e) => acc + Number(e.saldo?.saldoBloqueadoMed ?? 0), 0)
      .toFixed(2);

    const empresasResumo = empresas.map((e) => ({
      idPublico: e.idPublico,
      razaoSocial: e.razaoSocial,
      situacao: e.situacao,
      saldo: e.saldo
        ? {
            disponivel: e.saldo.saldoDisponivel.toString(),
            pendente: e.saldo.saldoPendenteLiberacao.toString(),
            reservado: e.saldo.saldoReservado.toString(),
            bloqueadoMed: e.saldo.saldoBloqueadoMed.toString(),
          }
        : null,
    }));

    if (empresaIds.length === 0) {
      return {
        empresas: empresasResumo,
        range: janela.range,
        saldoDisponivel,
        volumeBruto: '0',
        qtdTransacoes: 0,
        totais: { gerados: '0', pagos: '0', meds: bloqueadoMed },
        ticketMedio: '0',
        conversao: 0,
        geradasQtd: 0,
        aprovadasQtd: 0,
        serie: [],
        recentes: [],
      };
    }

    const whereEntrada = {
      empresaId: { in: empresaIds },
      direcao: 'ENTRADA' as const,
      criadoEm: { gte: janela.desde },
    };

    const [geradas, aprovadas, recentes, linhas] = await Promise.all([
      this.prisma.transacao.aggregate({
        where: whereEntrada,
        _sum: { valorBruto: true },
        _count: true,
      }),
      this.prisma.transacao.aggregate({
        where: { ...whereEntrada, situacao: { in: SITUACOES_APROVADAS as never } },
        _sum: { valorBruto: true },
        _count: true,
      }),
      this.prisma.transacao.findMany({
        where: { empresaId: { in: empresaIds }, direcao: 'ENTRADA' },
        orderBy: { criadoEm: 'desc' },
        take: 12,
        include: {
          pix: true,
          itens: { orderBy: { id: 'asc' } },
          empresa: { select: { razaoSocial: true } },
        },
      }),
      this.prisma.transacao.findMany({
        where: whereEntrada,
        select: { criadoEm: true, valorBruto: true, situacao: true },
        take: 20000,
      }),
    ]);

    // Série agrupada por hora (1d) ou por dia (7d/30d/mês), em JS.
    const baldes = new Map<string, { geradas: number; aprovadas: number }>();
    for (const l of linhas) {
      const d = l.criadoEm;
      const chave = janela.porHora
        ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}T${d.getHours()}`
        : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const b = baldes.get(chave) ?? { geradas: 0, aprovadas: 0 };
      const v = Number(l.valorBruto);
      b.geradas += v;
      if (SITUACOES_APROVADAS.includes(l.situacao)) b.aprovadas += v;
      baldes.set(chave, b);
    }
    const serie = Array.from(baldes.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([chave, b]) => ({
        ts: chave,
        geradas: b.geradas.toFixed(2),
        aprovadas: b.aprovadas.toFixed(2),
      }));

    const geradasQtd = Number(geradas._count ?? 0);
    const aprovadasQtd = Number(aprovadas._count ?? 0);
    const geradasValor = Number((geradas._sum?.valorBruto ?? 0).toString());
    const aprovadasValor = Number((aprovadas._sum?.valorBruto ?? 0).toString());
    const ticketMedio = aprovadasQtd > 0 ? aprovadasValor / aprovadasQtd : 0;
    const conversao = geradasQtd > 0 ? aprovadasQtd / geradasQtd : 0;

    return {
      empresas: empresasResumo,
      range: janela.range,
      saldoDisponivel,
      // Compatibilidade com a versão anterior do dashboard.
      volumeBruto: aprovadasValor.toFixed(2),
      qtdTransacoes: aprovadasQtd,
      totais: {
        gerados: geradasValor.toFixed(2),
        pagos: aprovadasValor.toFixed(2),
        meds: bloqueadoMed,
      },
      ticketMedio: ticketMedio.toFixed(2),
      conversao,
      geradasQtd,
      aprovadasQtd,
      serie,
      recentes: recentes.map((t) => ({
        idTransacao: t.idTransacaoPublico,
        cliente: t.pix?.nomePagador ?? '—',
        clienteEmail: t.pix?.emailPagador ?? null,
        produto: resumoProduto(t.itens, t.referenciaExterna),
        empresa: t.empresa.razaoSocial,
        valor: t.valorBruto.toString(),
        situacao: t.situacao,
        criadoEm: t.criadoEm,
      })),
    };
  }
}
