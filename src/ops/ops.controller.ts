import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  configuracaoWebhookSchema,
  EVENTOS_LOJISTA,
  MODO_TRATAMENTO_MED,
  inicioDoMesBrasilia,
  money,
  PERMISSOES,
  recorteFiltroData,
  resumoProduto,
  DISPONIBILIDADE_ADQUIRENTE,
  SITUACAO_DEVOLUCAO,
  SITUACAO_LIBERACAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  SITUACAO_USUARIO,
  normalizarIpOuCidr as normalizarRede,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  JwtAuthGuard,
  temEscopoGlobal,
  type UsuarioAutenticado,
} from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { QueuesService } from '../queues/queues.service';
import { ReenvioWebhookService } from '../queues/reenvio-webhook.service';
import { getRastreio } from '../common/request-context';
import { encryptCredentials, encryptText } from '../common/crypto.util';
import { AdquirentesService } from '../providers/adquirentes.service';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';
import { CashInCreditoService } from '../retencao/cashin-credito.service';
import { RelatorioMetodoService } from './relatorio-metodo.service';
import { RelatorioResultadoService } from './relatorio-resultado.service';
import {
  montarSerieDashboard,
  resolverIntervaloSerie,
  SITUACOES_APROVADAS_SERIE,
} from './dashboard-serie';

/**
 * Valida um IP ou CIDR (IPv4 e IPv6, ex.: `2804:14c::/64`) e devolve a forma
 * normalizada. A allowlist de webhook aceita faixa porque liquidante entrega
 * de blocos inteiros — recusar CIDR obrigaria a cadastrar IP por IP.
 */
function normalizarIpOuCidr(valor: string): string {
  const ip = normalizarRede(valor);
  if (!ip) {
    throw new BadRequestException(
      `IP ou CIDR inválido: "${valor.trim()}" (ex.: 187.10.0.5, 187.10.0.0/24, 2804:14c::/64).`,
    );
  }
  return ip;
}

@Controller('painel/webhooks')
@UseGuards(JwtAuthGuard)
export class WebhooksClienteController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tipos de evento que o gateway realmente emite. O painel PRECISA usar esta
   * lista: `tiposEvento` é filtro de entrega, então um nome que não existe faz
   * o webhook nunca receber nada — falha silenciosa.
   */
  @Get('eventos')
  @RequerPermissao(PERMISSOES.WEBHOOKS_VER)
  eventos() {
    return Object.values(EVENTOS_LOJISTA);
  }

  @Get()
  @RequerPermissao(PERMISSOES.WEBHOOKS_VER)
  async listar(@Req() req: { user: UsuarioAutenticado }) {
    // Removidos são desativados (soft delete) e não aparecem na listagem.
    const rows = await this.prisma.configuracaoWebhookUsuario.findMany({
      where: { usuarioId: BigInt(req.user.id), ativo: true },
      orderBy: { id: 'desc' },
    });
    return rows.map((w) => this.mapWebhook(w));
  }

  /** Resposta pública: id como string, sem ids internos (usuarioId). */
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

  @Post()
  @RequerPermissao(PERMISSOES.WEBHOOKS_CRIAR)
  async criar(@Req() req: { user: UsuarioAutenticado }, @Body() body: unknown) {
    const parsed = configuracaoWebhookSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const criado = await this.prisma.configuracaoWebhookUsuario.create({
      data: {
        usuarioId: BigInt(req.user.id),
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

  @Delete(':id')
  @RequerPermissao(PERMISSOES.WEBHOOKS_EXCLUIR)
  async remover(
    @Param('id') id: string,
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    // Soft delete: entregas_webhook referenciam esta config (histórico de
    // auditoria). Apagar violaria a FK e destruiria o histórico de entregas.
    const r = await this.prisma.configuracaoWebhookUsuario.updateMany({
      where: { id: BigInt(id), usuarioId: BigInt(req.user.id), ativo: true },
      data: { ativo: false },
    });
    if (r.count === 0) {
      throw new BadRequestException('Webhook não encontrado');
    }
    return { ok: true };
  }
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminOpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly adquirentes: AdquirentesService,
    private readonly reenvioWebhook: ReenvioWebhookService,
    private readonly cashInCredito: CashInCreditoService,
    private readonly relatorioMetodo: RelatorioMetodoService,
    private readonly apuracaoResultado: RelatorioResultadoService,
  ) {}

  /**
   * Guarda das ações que tiram uma adquirente de circulação para o PIX in.
   *
   * Nenhum cliente pode ficar sem adquirente de entrada: se ainda houver quem
   * use esta, o admin é obrigado a mandar as substituições no mesmo request, e
   * o remanejamento acontece na MESMA transação da mudança.
   */
  private async remanejarAntesDeTirarDeCirculacao(
    codigo: string,
    substituicoes: Array<{ usuarioIdPublico: string; adquirenteCodigo: string }> | undefined,
    atorId: bigint,
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ) {
    const afetados = await this.adquirentes.clientesAfetados(codigo);
    if (afetados.length === 0) return;
    if (!substituicoes?.length) {
      throw new BadRequestException(
        `${afetados.length} cliente(s) usam esta adquirente no PIX in. ` +
          'Escolha a adquirente substituta de cada um antes de tirá-la de circulação.',
      );
    }
    await this.adquirentes.aplicarSubstituicoes(tx, codigo, substituicoes, atorId);
  }

  @Get('dashboard')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async dashboard() {
    const [usuarios, clientesAtivos, transacoes, volume] = await Promise.all([
      this.prisma.usuario.count(),
      this.prisma.usuario.count({ where: { situacao: SITUACAO_USUARIO.ATIVO } }),
      this.prisma.transacao.count(),
      this.prisma.transacao.aggregate({
        _sum: { valorBruto: true, valorMargemBruta: true },
        where: { situacao: SITUACAO_TRANSACAO.CONCLUIDA },
      }),
    ]);
    const porDia = await this.prisma.$queryRaw<
      Array<{ dia: Date; volume: string; margem: string; qtd: bigint }>
    >`
      SELECT (date_trunc('day', criado_em AT TIME ZONE 'America/Sao_Paulo')
                AT TIME ZONE 'America/Sao_Paulo') AS dia,
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
      clientesAtivos,
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
   * Relatório Método — dashboard operacional de cash-in PIX (volume, conversão,
   * saúde PIX, breakdown por adquirente/usuário e gráfico de faturamento).
   */
  @Get('relatorios/metodo')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async relatorioMetodoEndpoint(@Query() q: Record<string, string>) {
    return this.relatorioMetodo.gerar({
      dataInicial: q.dataInicial,
      dataFinal: q.dataFinal,
      adquirente: q.adquirente,
      usuario: q.usuario ?? q.user,
      ocultarRetidas: q.ocultarRetidas === '1' || q.ocultarRetidas === 'true',
    });
  }

  /**
   * Relatório "Apuração de Resultado (Lucro × Custo)": confronta a receita
   * efetivamente cobrada do cliente (tarifa persistida em venda PAGA) com o
   * custo persistido da adquirente. Mudanças posteriores de config não
   * reescrevem o histórico.
   */
  @Get('relatorios/resultado')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async relatorioResultado(@Query() q: Record<string, string>) {
    return this.apuracaoResultado.gerar({
      dataInicial: q.dataInicial,
      dataFinal: q.dataFinal,
      tipo: q.tipo,
      cliente: q.cliente,
      adquirente: q.adquirente,
      resultado: q.resultado,
    });
  }

  /**
   * Relatório de transações admin (todos os clientes) para Cash-in (ENTRADA) e
   * Cash-out (SAIDA). Paginação SERVER-SIDE (skip/take + count) — cresce em
   * volume. Filtros por período, cliente, adquirente, situação e busca.
   */
  @Get('relatorios/transacoes')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async relatorioTransacoes(@Query() q: Record<string, string>) {
    const direcao = q.direcao === 'SAIDA' ? 'SAIDA' : 'ENTRADA';
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 25));

    const where: Record<string, unknown> = { direcao };
    const periodoTx = recorteFiltroData(q.dataInicial, q.dataFinal);
    if (periodoTx) where.criadoEm = periodoTx;
    if (q.situacao) where.situacao = q.situacao;

    // Cada filtro de texto vira um grupo `OR` próprio; os grupos se combinam
    // por AND — senão o `OR` da busca por referência sobrescreveria o `OR`
    // da busca por cliente (e vice-versa).
    const condicoesE: Array<Record<string, unknown>> = [];

    const busca = (q.busca ?? '').trim();
    if (busca) {
      const orBusca: Array<Record<string, unknown>> = [
        { referenciaExterna: { contains: busca, mode: 'insensitive' } },
        // endToEnd e txid são VarChar — `contains` funciona direto.
        {
          pix: {
            is: { identificadorFimAFim: { contains: busca, mode: 'insensitive' } },
          },
        },
        { pix: { is: { txid: { contains: busca, mode: 'insensitive' } } } },
      ];

      /**
       * Correlação com o Redis/Bull: o job de saque/webhook carrega
       * `transacaoId` (id interno, que também é o sufixo do jobId `saque-7`)
       * e `idTransacaoPrivado` — os dois têm que achar a transação aqui,
       * senão o operador vê o job na fila e não encontra a linha no relatório.
       * Aceita o jobId colado inteiro (`saque-7`, `webhook-out-7`).
       */
      const idInterno = /^(?:saque-|webhook-(?:in|out)-)?(\d{1,18})$/i.exec(busca);
      if (idInterno) orBusca.push({ id: BigInt(idInterno[1]) });

      /**
       * `id_transacao_publico` e `id_transacao_privado` são colunas UUID: o
       * Postgres não faz LIKE em uuid e o Prisma recusa `contains` nesse tipo.
       * Só que a tabela mostra o id ABREVIADO (#6147dbe2), então o que o admin
       * copia da tela é um PREFIXO — comparar por igualdade nunca acha.
       * Resolve com cast em SQL cru, nas DUAS colunas (o privado é o que o
       * job da fila mostra).
       *
       * O termo é reduzido a [0-9a-f-], o que também elimina os curingas `%`/`_`
       * do LIKE. Mínimo de 4 caracteres: com menos, o prefixo é genérico demais
       * e a lista de ids cresceria sem necessidade (a 4 chars hex já é 1 em 65k).
       */
      const prefixo = busca.toLowerCase().replace(/[^0-9a-f-]/g, '');
      if (prefixo.length >= 4) {
        const achados = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM transacoes
          WHERE id_transacao_publico::text LIKE ${prefixo + '%'}
             OR id_transacao_privado::text LIKE ${prefixo + '%'}
          LIMIT 5000
        `;
        if (achados.length) orBusca.push({ id: { in: achados.map((r) => r.id) } });
      }

      condicoesE.push({ OR: orBusca });
    }
    const cliente = (q.cliente ?? '').trim();
    if (cliente) {
      // "Cliente" busca tanto o lojista dono da conta quanto quem aparece na
      // própria operação — pagador do PIX (cash-in) ou beneficiário do saque
      // (cash-out) — porque é isso que a coluna "Cliente"/"Beneficiário" da
      // tabela mostra; buscar só pelo lojista não achava quem o admin via na tela.
      condicoesE.push({
        OR: [
          {
            usuario: {
              OR: [
                { nomeRazaoSocial: { contains: cliente, mode: 'insensitive' } },
                { nomeFantasia: { contains: cliente, mode: 'insensitive' } },
                { email: { contains: cliente, mode: 'insensitive' } },
              ],
            },
          },
          {
            pix: {
              is: {
                OR: [
                  { nomePagador: { contains: cliente, mode: 'insensitive' } },
                  { emailPagador: { contains: cliente, mode: 'insensitive' } },
                  { nomeBeneficiario: { contains: cliente, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }
    if (condicoesE.length) where.AND = condicoesE;

    if (q.adquirente) {
      const contas = await this.prisma.contaProvedor.findMany({
        where: { provedor: { codigo: q.adquirente } },
        select: { id: true },
      });
      where.contaProvedorId = { in: contas.map((c) => c.id) };
    }
    if (q.metodo === 'sim') where.retidaMetodo = true;
    if (q.metodo === 'nao') where.retidaMetodo = false;
    if (q.medAutomatico === 'sim') where.medAutomatico = true;
    if (q.medAutomatico === 'nao') where.medAutomatico = false;

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
          usuario: {
            select: { nomeRazaoSocial: true, idPublico: true, email: true },
          },
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
        empresa: t.usuario.nomeRazaoSocial,
        empresaEmail: t.usuario.email,
        cliente: t.pix?.nomePagador ?? '—',
        clienteEmail: t.pix?.emailPagador ?? null,
        // Quando o dinheiro efetivamente caiu/saiu. Nulo enquanto a operação não
        // liquidou — é o que separa "criada em" de "paga em" no relatório.
        dataPagamento: t.liquidadoEm ?? t.concluidoEm ?? null,
        // O identificador do pedido no sistema do lojista: é por ele que o
        // suporte cruza a venda com o ERP/checkout do cliente.
        referenciaExterna: t.referenciaExterna,
        codigoPagamento: t.pix?.pixCopiaCola ?? null,
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
        retidaMetodo: t.retidaMetodo,
        medAutomatico: t.medAutomatico,
      })),
    };
  }

  /**
   * Detalhe de UMA transação para o admin/suporte, com a RESPOSTA DO BANCO.
   *
   * É o que dá ao suporte como explicar ao cliente por que um saque falhou: a
   * resposta bruta da liquidante fica em `tentativas_transacoes` (dadosResposta
   * / statusHttp / mensagemErro) — gravada na criação (sucesso e recusa) e na
   * conciliação — e o corpo dos webhooks do banco em `webhooks_recebidos_provedor`.
   * O relatório em lista não carrega isso (seria JSON grande por linha); aqui,
   * sob demanda, devolvemos o rastro completo. Admin vê qualquer conta (sem
   * filtro por usuarioId) — é `ADMIN_RELATORIOS_VER`.
   */
  @Get('relatorios/transacoes/:idTransacao')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async detalheTransacao(@Param('idTransacao') idTransacao: string) {
    const tx = await this.prisma.transacao.findUnique({
      where: { idTransacaoPublico: idTransacao },
      include: {
        pix: true,
        usuario: { select: { nomeRazaoSocial: true, idPublico: true, email: true } },
        contaProvedor: { select: { provedor: { select: { codigo: true } } } },
        tentativas: { orderBy: { numeroTentativa: 'asc' } },
      },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');

    // Webhooks do banco casam pela id da liquidante das tentativas (não há FK
    // direta transação→webhook: o match é sempre pelo id externo).
    const liquidanteIds = tx.tentativas
      .map((t) => t.idTransacaoLiquidante)
      .filter((id): id is string => !!id);
    const webhooks = liquidanteIds.length
      ? await this.prisma.webhookRecebidoProvedor.findMany({
          where: { identificadorEventoExterno: { in: liquidanteIds } },
          orderBy: { recebidoEm: 'asc' },
        })
      : [];

    return {
      idTransacao: tx.idTransacaoPublico,
      direcao: tx.direcao,
      situacao: tx.situacao,
      empresa: tx.usuario.nomeRazaoSocial,
      empresaEmail: tx.usuario.email,
      valorBruto: tx.valorBruto.toString(),
      valorTarifa: tx.valorTarifaPix.toString(),
      valorLiquido: tx.valorLiquidacaoEmpresa.toString(),
      referenciaExterna: tx.referenciaExterna,
      adquirente: tx.contaProvedor?.provedor?.codigo ?? null,
      beneficiario: tx.pix?.nomeBeneficiario ?? null,
      chavePix: tx.pix?.chavePix ?? null,
      documentoBeneficiario: tx.pix?.documentoBeneficiario ?? null,
      endToEnd: tx.pix?.identificadorFimAFim ?? null,
      criadoEm: tx.criadoEm,
      liquidadoEm: tx.liquidadoEm,
      concluidoEm: tx.concluidoEm,
      falhouEm: tx.falhouEm,
      /**
       * A RESPOSTA DO BANCO por tentativa — o campo que o suporte lê para
       * repassar ao cliente o motivo real da recusa/falha.
       */
      tentativas: tx.tentativas.map((t) => ({
        numero: t.numeroTentativa,
        situacao: t.situacao,
        statusHttp: t.statusHttp,
        codigoErro: t.codigoErro,
        mensagemErro: t.mensagemErro,
        idTransacaoLiquidante: t.idTransacaoLiquidante,
        respostaBanco: t.dadosResposta ?? null,
        criadoEm: t.criadoEm,
        concluidoEm: t.concluidoEm,
      })),
      /** Corpo cru dos webhooks que o banco enviou para esta operação. */
      webhooksBanco: webhooks.map((w) => ({
        tipoEvento: w.tipoEvento,
        situacao: w.situacao,
        conteudo: w.conteudo,
        recebidoEm: w.recebidoEm,
        processadoEm: w.processadoEm,
      })),
    };
  }

  /**
   * DINHEIRO PARADO — todo valor que está preso em algum ponto do sistema, com
   * o MOTIVO já gravado, num lugar só.
   *
   * Substitui a "análise caso a caso": em vez de o admin descobrir nos logs o
   * que travou, cada categoria lista as linhas com a causa que o próprio fluxo
   * registrou (mensagemErro da tentativa, ultimoErro da devolução, ultimoErro
   * da liberação). As categorias são exatamente os pontos onde o desenho
   * CONGELA em vez de retentar:
   *
   * - saque sem desfecho: PROCESSANDO com tentativa ENVIANDO (ambíguo — runbook
   *   §2) ou sem nenhuma tentativa ativa há mais de 15 min (enfileiramento/
   *   revalidação falhando; o reprocesso automático da conciliação cuida, mas
   *   se persiste aqui é porque está em loop e precisa de gente);
   * - devolução presa: tudo que não é CONCLUIDA (PENDENTE velha em retry,
   *   PROCESSANDO órfã, AMBIGUA congelada, FALHA recusada/teto);
   * - liberação travada: FALHA no teto de tentativas (a fila 6 já desistiu);
   * - cash-in fantasma: FALHA com TIMEOUT — pode existir cobrança pagável na
   *   liquidante sem venda local (runbook §3).
   *
   * Cada lista tem um teto (`take`) e vem ordenada da mais antiga para a mais
   * nova — a paginação fina é do front (client-side, padrão das telas de fila).
   */
  @Get('relatorios/dinheiro-parado')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_VER)
  async dinheiroParado() {
    const agora = Date.now();
    const min = (n: number) => new Date(agora - n * 60 * 1000);

    const [saques, devolucoes, liberacoes, fantasmas] = await Promise.all([
      this.prisma.transacao.findMany({
        where: {
          direcao: 'SAIDA',
          situacao: SITUACAO_TRANSACAO.PROCESSANDO,
          criadoEm: { lte: min(15) },
        },
        include: {
          usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
          tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 1 },
        },
        orderBy: { criadoEm: 'asc' },
        take: 100,
      }),
      this.prisma.devolucaoPix.findMany({
        where: {
          situacao: { not: SITUACAO_DEVOLUCAO.CONCLUIDA },
          criadoEm: { lte: min(10) },
        },
        include: {
          transacao: {
            select: {
              idTransacaoPublico: true,
              usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
            },
          },
        },
        orderBy: { criadoEm: 'asc' },
        take: 100,
      }),
      this.prisma.liberacaoSaldo.findMany({
        where: {
          situacao: SITUACAO_LIBERACAO.FALHA,
          quantidadeTentativas: { gte: 8 },
        },
        // LiberacaoSaldo não tem relação direta com usuario — vem pela venda.
        include: {
          transacao: {
            select: {
              idTransacaoPublico: true,
              usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
            },
          },
        },
        orderBy: { liberarEm: 'asc' },
        take: 100,
      }),
      this.prisma.transacao.findMany({
        where: {
          direcao: 'ENTRADA',
          situacao: SITUACAO_TRANSACAO.FALHA,
          tentativas: { some: { mensagemErro: { contains: 'TIMEOUT' } } },
          criadoEm: { gte: min(30 * 24 * 60) },
        },
        include: {
          usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
          tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 1 },
        },
        orderBy: { criadoEm: 'asc' },
        take: 100,
      }),
    ]);

    return {
      saquesSemDesfecho: saques.map((tx) => {
        const ultima = tx.tentativas[0];
        const emVoo = ultima?.situacao === SITUACAO_TENTATIVA.ENVIANDO;
        return {
          idTransacao: tx.idTransacaoPublico,
          cliente: tx.usuario.nomeRazaoSocial,
          clienteIdPublico: tx.usuario.idPublico,
          valor: tx.valorBruto.toString(),
          criadoEm: tx.criadoEm,
          /** AMBIGUO = ordem em voo (runbook §2); SEM_TENTATIVA = nunca saiu. */
          tipo: emVoo ? 'AMBIGUO' : ultima ? 'COM_TENTATIVA' : 'SEM_TENTATIVA',
          motivo:
            ultima?.mensagemErro ??
            (ultima
              ? `tentativa ${ultima.situacao} sem mensagem`
              : 'nenhuma tentativa registrada — enfileiramento/revalidação em loop'),
        };
      }),
      devolucoesPresas: devolucoes.map((d) => ({
        idDevolucao: d.idDevolucaoPublico,
        idTransacao: d.transacao.idTransacaoPublico,
        cliente: d.transacao.usuario.nomeRazaoSocial,
        clienteIdPublico: d.transacao.usuario.idPublico,
        valor: d.valor.toString(),
        situacao: d.situacao,
        tentativas: d.quantidadeTentativas,
        criadoEm: d.criadoEm,
        motivo: d.ultimoErro ?? 'aguardando processamento',
      })),
      liberacoesTravadas: liberacoes.map((l) => ({
        id: l.id.toString(),
        idTransacao: l.transacao.idTransacaoPublico,
        cliente: l.transacao.usuario.nomeRazaoSocial,
        clienteIdPublico: l.transacao.usuario.idPublico,
        valor: l.valor.toString(),
        tipo: l.tipoLiberacao,
        liberarEm: l.liberarEm,
        tentativas: l.quantidadeTentativas,
        motivo: l.ultimoErro ?? 'teto de tentativas atingido',
      })),
      cashinFantasma: fantasmas.map((tx) => ({
        idTransacao: tx.idTransacaoPublico,
        cliente: tx.usuario.nomeRazaoSocial,
        clienteIdPublico: tx.usuario.idPublico,
        valor: tx.valorBruto.toString(),
        criadoEm: tx.criadoEm,
        motivo: tx.tentativas[0]?.mensagemErro ?? 'TIMEOUT sem detalhe',
      })),
    };
  }

  /**
   * Reenvia o callback de uma transação de QUALQUER conta (suporte). Vai para a
   * fila dedicada `11-webhook-reenvio` — reenvio manual não se mistura com a
   * entrega automática.
   */
  @Post('relatorios/transacoes/:idTransacao/reenviar-webhook')
  @RequerPermissao(PERMISSOES.ADMIN_FILAS_EXECUTAR)
  async reenviarWebhookAdmin(
    @Param('idTransacao') idTransacao: string,
    @Req() req: { user: UsuarioAutenticado; ip?: string },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    return this.reenvioWebhook.solicitar({
      idTransacaoPublico: idTransacao,
      atorId: BigInt(req.user.id),
      enderecoIp: req.ip,
    });
  }

  /**
   * Libera venda retida pelo método: credita saldo + CONCLUIDA + callback.
   * Exige 2FA do ator e `admin.relatorios.editar`.
   */
  @Post('relatorios/transacoes/:idTransacao/liberar-retencao')
  @RequerPermissao(PERMISSOES.ADMIN_RELATORIOS_EDITAR)
  async liberarRetencao(
    @Param('idTransacao') idTransacao: string,
    @Body() body: unknown,
    @Req() req: { user: UsuarioAutenticado },
  ) {
    const parsed = z
      .object({ codigoTotp: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos') })
      .safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);

    const ator = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
      select: { idPublico: true },
    });

    const tx = await this.prisma.transacao.findFirst({
      where: { idTransacaoPublico: idTransacao, direcao: 'ENTRADA' },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');
    if (!tx.retidaMetodo) {
      throw new BadRequestException('Esta venda não está retida pelo método');
    }
    if (tx.situacao !== SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO) {
      throw new BadRequestException(
        `Situação atual (${tx.situacao}) não permite liberação do método`,
      );
    }

    return this.cashInCredito.creditar({
      transacaoId: tx.id,
      liquidadoEm: tx.liquidadoEm ?? new Date(),
      origem: 'LIBERACAO_RETENCAO_ADMIN',
      motivo: `Liberação manual do método por usuário ${ator.idPublico}`,
      identificadorRastreio: `liberar-retencao:${tx.id}`,
    });
  }

  /**
   * Auditoria: monitora as persistências do sistema (`registros_auditoria`:
   * quem fez, IP, como era → como ficou) e os acessos (`auditorias_acesso`).
   * Paginação server-side + filtros.
   */
  @Get('auditoria')
  @RequerPermissao(PERMISSOES.ADMIN_AUDITORIA_VER)
  async auditoria(@Query() q: Record<string, string>) {
    const fonte = q.fonte === 'acesso' ? 'acesso' : 'persistencia';
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 25));
    const skip = (pagina - 1) * limite;
    const periodo = () => recorteFiltroData(q.dataInicial, q.dataFinal);

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
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_VER)
  async provedores() {
    const rows = await this.prisma.provedorPagamento.findMany({
      include: { ipsWebhook: true },
    });
    // Nunca devolver contas/credenciais nem hash de segredo de webhook.
    return rows.map((p) => ({
      codigo: p.codigo,
      nome: p.nome,
      nomeFantasia: p.nomeFantasia,
      temMed: p.temMed,
      observacaoCliente: p.observacaoCliente,
      disponibilidadePixEntrada: p.disponibilidadePixEntrada,
      situacao: p.situacao,
      permitePixEntrada: p.permitePixEntrada,
      permitePixSaida: p.permitePixSaida,
      exigeAssinaturaWebhook: p.exigeAssinaturaWebhook,
      ipsWebhook: p.ipsWebhook.map((i) => i.ipOuCidr),
    }));
  }

  @Put('provedores/:codigo/situacao')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async situacaoProvedor(
    @Param('codigo') codigo: string,
    @Body()
    body: {
      situacao: 'ATIVO' | 'INATIVO' | 'SUSPENSO';
      substituicoes?: Array<{ usuarioIdPublico: string; adquirenteCodigo: string }>;
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string } },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const situacoesValidas: string[] = [
      SITUACAO_PROVEDOR.ATIVO,
      SITUACAO_PROVEDOR.INATIVO,
      SITUACAO_PROVEDOR.SUSPENSO,
    ];
    if (!situacoesValidas.includes(body?.situacao)) {
      throw new BadRequestException('situacao inválida');
    }
    if (
      process.env.NODE_ENV === 'production' &&
      codigo === 'mock' &&
      body.situacao === SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new BadRequestException(
        'Não é permitido ativar a adquirente mock em produção (crédito fictício).',
      );
    }
    const p = await this.prisma.$transaction(async (tx) => {
      // Inativar/suspender derruba o PIX in de quem estiver nela.
      if (body.situacao !== SITUACAO_PROVEDOR.ATIVO) {
        await this.remanejarAntesDeTirarDeCirculacao(
          codigo,
          body.substituicoes,
          BigInt(req.user.id),
          tx,
        );
      }
      return tx.provedorPagamento.update({
        where: { codigo },
        data: { situacao: body.situacao },
      });
    });
    return { codigo: p.codigo, nome: p.nome, situacao: p.situacao };
  }

  /**
   * Alternância EM MASSA de adquirente: troca a conta de roteamento dos
   * clientes (config por usuário + padrão do sistema) para uma adquirente
   * escolhida, por direção (cash-in e/ou cash-out).
   *
   * `origemCodigo` restringe a troca a quem está HOJE naquela adquirente (por
   * direção) — é a migração origem→destino. Sem origem, a troca vale para
   * todos os clientes, seja qual for a adquirente atual.
   *
   * Libera a adquirente destino para os afetados quando ela é ESPECIFICOS: sem
   * isso, forçar a troca deixaria os clientes usando uma adquirente que eles
   * não podem escolher no painel.
   */
  @Post('adquirentes/alternar-massa')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async alternarAdquirenteMassa(
    @Req() req: { user: { id: string }; ip?: string },
    @Body()
    body: {
      adquirenteCodigo?: string;
      origemCodigo?: string;
      cashIn?: boolean;
      cashOut?: boolean;
      codigoTotp?: string;
    },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const codigo = (body?.adquirenteCodigo ?? '').trim();
    if (!codigo) throw new BadRequestException('Informe a adquirente destino.');
    if (!body.cashIn && !body.cashOut) {
      throw new BadRequestException('Selecione cash-in e/ou cash-out.');
    }
    const origem = (body?.origemCodigo ?? '').trim() || null;
    if (origem === codigo) {
      throw new BadRequestException('Origem e destino são a mesma adquirente.');
    }
    if (origem) {
      const existeOrigem = await this.prisma.provedorPagamento.findUnique({
        where: { codigo: origem },
      });
      if (!existeOrigem) throw new BadRequestException('Adquirente de origem não encontrada.');
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

    const afetados = { usuarios: 0, padrao: 0 };
    await this.prisma.$transaction(async (tx) => {
      if (contaEntrada) {
        // Com origem, só migra quem está NELA hoje (por direção).
        const filtroEntrada = origem
          ? { contaEntrada: { provedor: { codigo: origem } } }
          : {};
        const configs = await tx.configuracaoPixUsuario.findMany({
          where: filtroEntrada,
          select: { usuarioId: true },
        });
        afetados.usuarios += (
          await tx.configuracaoPixUsuario.updateMany({
            where: filtroEntrada,
            data: {
              contaProvedorPixEntradaId: contaEntrada.id,
              adquirentePixEntradaTrocadaEm: new Date(),
              atualizadoPorUsuarioId: BigInt(req.user.id),
            },
          })
        ).count;
        afetados.padrao += (
          await tx.configuracaoPadraoPixUsuario.updateMany({
            where: {
              padraoSistema: true,
              ...(origem
                ? { contaEntrada: { provedor: { codigo: origem } } }
                : {}),
            },
            data: { contaProvedorPixEntradaId: contaEntrada.id },
          })
        ).count;
        const provedor = await tx.provedorPagamento.findUniqueOrThrow({
          where: { codigo },
        });
        if (provedor.disponibilidadePixEntrada === DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS) {
          await tx.liberacaoAdquirenteUsuario.createMany({
            data: configs.map((c) => ({
              provedorPagamentoId: provedor.id,
              usuarioId: c.usuarioId,
              liberadoPorUsuarioId: BigInt(req.user.id),
            })),
            skipDuplicates: true,
          });
        }
      }
      if (contaSaida) {
        await tx.configuracaoPixUsuario.updateMany({
          where: origem ? { contaSaida: { provedor: { codigo: origem } } } : {},
          data: { contaProvedorPixSaidaId: contaSaida.id },
        });
        await tx.configuracaoPadraoPixUsuario.updateMany({
          where: {
            padraoSistema: true,
            ...(origem ? { contaSaida: { provedor: { codigo: origem } } } : {}),
          },
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
      padraoAtualizado: afetados.padrao > 0,
    };
  }

  /** Detalhe de uma adquirente: informações + contas com custo configurado. */
  @Get('adquirentes/:codigo')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_VER)
  async adquirenteDetalhe(@Param('codigo') codigo: string) {
    const p = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
      include: {
        contas: { include: { custoPix: true }, orderBy: { id: 'asc' } },
        ipsWebhook: { orderBy: { id: 'asc' } },
      },
    });
    if (!p) throw new BadRequestException('Adquirente não encontrada');
    return {
      codigo: p.codigo,
      nome: p.nome,
      nomeFantasia: p.nomeFantasia,
      temMed: p.temMed,
      observacaoCliente: p.observacaoCliente,
      disponibilidadePixEntrada: p.disponibilidadePixEntrada,
      situacao: p.situacao,
      permitePixEntrada: p.permitePixEntrada,
      permitePixSaida: p.permitePixSaida,
      exigeAssinaturaWebhook: p.exigeAssinaturaWebhook,
      ipsWebhook: p.ipsWebhook.map((i) => i.ipOuCidr),
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
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async editarAdquirente(
    @Param('codigo') codigo: string,
    @Body()
    body: {
      nome?: string;
      permitePixEntrada?: boolean;
      permitePixSaida?: boolean;
      exigeAssinaturaWebhook?: boolean;
      substituicoes?: Array<{ usuarioIdPublico: string; adquirenteCodigo: string }>;
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const antes = await this.prisma.provedorPagamento.findUnique({ where: { codigo } });
    if (!antes) throw new BadRequestException('Adquirente não encontrada');
    const p = await this.prisma.$transaction(async (tx) => {
      // Desligar o PIX in tira a adquirente de circulação para cash-in.
      if (antes.permitePixEntrada && body.permitePixEntrada === false) {
        await this.remanejarAntesDeTirarDeCirculacao(
          codigo,
          body.substituicoes,
          BigInt(req.user.id),
          tx,
        );
      }
      const atualizado = await tx.provedorPagamento.update({
        where: { codigo },
        data: {
          nome: body.nome?.trim() || undefined,
          permitePixEntrada: body.permitePixEntrada,
          permitePixSaida: body.permitePixSaida,
          exigeAssinaturaWebhook: body.exigeAssinaturaWebhook,
        },
      });
      // Cura adquirente cadastrada antes de a conta padrão nascer junto:
      // salvar a edição garante a conta que o roteamento aponta.
      await this.garantirContaPadrao(tx, atualizado);
      return atualizado;
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

  /**
   * IPs de webhook da liquidante (Camada 2). Substitui a lista inteira —
   * aceita IP ou CIDR, IPv4 e IPv6 (ex.: /64). Lista vazia desliga a checagem
   * de IP e deixa a segurança só com token/assinatura + Camada 1.
   */
  @Put('adquirentes/:codigo/ips-webhook')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async editarIpsWebhook(
    @Param('codigo') codigo: string,
    @Body() body: { ips?: string[]; codigoTotp?: string },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
      include: { ipsWebhook: true },
    });
    if (!provedor) throw new BadRequestException('Adquirente não encontrada');
    if (!Array.isArray(body?.ips)) {
      throw new BadRequestException('Informe `ips` como lista.');
    }
    if (body.ips.length > 100) {
      throw new BadRequestException('Máximo de 100 IPs/faixas por adquirente.');
    }
    const normalizados = [...new Set(body.ips.map(normalizarIpOuCidr))];

    const antes = provedor.ipsWebhook.map((i) => i.ipOuCidr);
    await this.prisma.$transaction([
      this.prisma.ipPermitidoWebhookProvedor.deleteMany({
        where: { provedorPagamentoId: provedor.id },
      }),
      this.prisma.ipPermitidoWebhookProvedor.createMany({
        data: normalizados.map((ipOuCidr) => ({
          provedorPagamentoId: provedor.id,
          ipOuCidr,
        })),
      }),
    ]);
    await this.auditar(
      req,
      'ADQUIRENTE_IPS_WEBHOOK_EDITAR',
      'ips_permitidos_webhook_provedor',
      codigo,
      { ips: antes },
      { ips: normalizados },
    );
    return { ok: true, ips: normalizados };
  }

  /** Edita o CUSTO (o que a adquirente cobra de nós) de uma conta. */
  @Put('adquirentes/contas/:contaId/custo')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_EDITAR)
  async editarCustoConta(
    @Param('contaId') contaId: string,
    @Body()
    body: {
      custoPixEntradaPercentual?: number | string;
      custoPixEntradaFixo?: number | string;
      custoPixSaidaPercentual?: number | string;
      custoPixSaidaFixo?: number | string;
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
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

  // As condições padrão de novos clientes (taxa, prazo de liberação, reserva,
  // MED) vivem em `GET|PUT /admin/usuarios/config-padrao`: é contrato de
  // cliente, não configuração de adquirente.

  /**
   * Garante a CONTA padrão da adquirente (`<codigo>:default`). É nela que o
   * roteamento (config do cliente e padrão do sistema) se pendura — e nenhum
   * outro fluxo do produto cria conta: sem isto, adquirente cadastrada pelo
   * painel ficava sem conta e nada conseguia apontar para ela (o PUT do
   * "Padrão de novos clientes" respondia "cadastre uma adquirente" mesmo com a
   * adquirente na tela). Credenciais nascem VAZIAS de propósito: os clients
   * caem no fallback de env (ex.: `VALORION_*`), que é onde as chaves reais
   * vivem em produção. Conta já existente não é tocada.
   */
  private async garantirContaPadrao(
    tx: Pick<PrismaService, 'contaProvedor'>,
    provedor: { id: bigint; codigo: string; nome: string },
  ) {
    await tx.contaProvedor.upsert({
      where: { chaveUnicaConta: `${provedor.codigo}:default` },
      create: {
        provedorPagamentoId: provedor.id,
        nome: `${provedor.nome} — conta padrão`,
        chaveUnicaConta: `${provedor.codigo}:default`,
        identificadorContaExterna: 'default',
        credenciaisCriptografadas: encryptCredentials({}),
        pixEntradaHabilitado: true,
        pixSaidaHabilitado: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: {},
    });
  }

  /** Cadastro de nova adquirente (nasce INATIVA; a conta padrão nasce junto). */
  @Post('adquirentes')
  @RequerPermissao(PERMISSOES.ADMIN_ADQUIRENTES_CRIAR)
  async criarAdquirente(
    @Body()
    body: {
      codigo?: string;
      nome?: string;
      permitePixEntrada?: boolean;
      permitePixSaida?: boolean;
      /** IPs/faixas (CIDR, inclusive IPv6 /64) de onde a liquidante entrega webhook. */
      ipsWebhook?: string[];
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const codigo = (body.codigo ?? '').trim().toLowerCase();
    const nome = (body.nome ?? '').trim();
    if (!/^[a-z0-9_]{2,50}$/.test(codigo)) {
      throw new BadRequestException('Código inválido (a-z, 0-9, _; 2 a 50 caracteres).');
    }
    if (!nome) throw new BadRequestException('Informe o nome da adquirente.');
    // Validar ANTES de criar: IP inválido não pode deixar a adquirente pela metade.
    const ips = [...new Set((body.ipsWebhook ?? []).map(normalizarIpOuCidr))];
    const existe = await this.prisma.provedorPagamento.findUnique({ where: { codigo } });
    if (existe) throw new BadRequestException('Já existe uma adquirente com esse código.');
    const p = await this.prisma.provedorPagamento.create({
      data: {
        codigo,
        nome,
        situacao: SITUACAO_PROVEDOR.INATIVO,
        permitePixEntrada: body.permitePixEntrada ?? false,
        permitePixSaida: body.permitePixSaida ?? false,
        ...(ips.length
          ? { ipsWebhook: { create: ips.map((ipOuCidr) => ({ ipOuCidr })) } }
          : {}),
      },
    });
    await this.garantirContaPadrao(this.prisma, p);
    await this.auditar(req, 'ADQUIRENTE_CADASTRAR', 'provedores_pagamento', codigo, null, {
      codigo: p.codigo,
      nome: p.nome,
      ipsWebhook: ips,
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
  @RequerPermissao(PERMISSOES.ADMIN_FILAS_EXECUTAR)
  async reenviar(
    @Param('entregaId') entregaId: string,
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
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
        usuarioId: entrega.usuarioId.toString(),
        eventoOutboxId: entrega.eventoOutboxId.toString(),
      },
      identificadorRastreio: getRastreio(),
    });
    return { ok: true };
  }
}

/** Situações que contam como venda "aprovada" (dinheiro que entrou). */
const SITUACOES_APROVADAS: string[] = [...SITUACOES_APROVADAS_SERIE];

/**
 * Converte `?range=` na janela + granularidade do gráfico.
 *
 * `desdeAnterior` é a janela imediatamente anterior, de mesma duração, usada
 * para o comparativo ("+12% vs. período anterior") no painel do lojista.
 */
function resolverJanela(range?: string): {
  range: string;
  desde: Date;
  ate: Date;
  desdeAnterior: Date;
  porHora: boolean;
} {
  const agora = new Date();
  const dia = 24 * 60 * 60 * 1000;
  const janela = (desde: Date, r: string, porHora: boolean) => ({
    range: r,
    desde,
    ate: agora,
    desdeAnterior: new Date(desde.getTime() - (agora.getTime() - desde.getTime())),
    porHora,
  });

  switch (range) {
    case '30d':
      return janela(new Date(agora.getTime() - 30 * dia), '30d', false);
    case '7d':
      return janela(new Date(agora.getTime() - 7 * dia), '7d', false);
    case 'mes':
      return janela(inicioDoMesBrasilia(agora), 'mes', false);
    default:
      // 1 dia: últimas 24h por hora.
      return janela(new Date(agora.getTime() - dia), '1d', true);
  }
}

@Controller('painel/dashboard')
@UseGuards(JwtAuthGuard)
export class PainelDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequerPermissao(PERMISSOES.DASHBOARD_VER)
  async meu(
    @Req() req: { user: { id: string } },
    @Query('range') range?: string,
    @Query('intervalo') intervalo?: string,
  ) {
    const usuarioId = BigInt(req.user.id);
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
      include: { saldo: true, configuracaoPix: true },
    });
    const janela = resolverJanela(range);
    const intervaloSerie = resolverIntervaloSerie(intervalo);

    const saldoDisponivel = (usuario.saldo?.saldoDisponivel ?? 0).toString();
    const bloqueadoMed = (usuario.saldo?.saldoBloqueadoMed ?? 0).toString();

    const cfg = usuario.configuracaoPix;
    const conta = {
      idPublico: usuario.idPublico,
      nome: usuario.nomeFantasia ?? usuario.nomeRazaoSocial,
      situacao: usuario.situacao,
      saldo: usuario.saldo
        ? {
            disponivel: usuario.saldo.saldoDisponivel.toString(),
            pendente: usuario.saldo.saldoPendenteLiberacao.toString(),
            reservado: usuario.saldo.saldoReservado.toString(),
            bloqueadoMed: usuario.saldo.saldoBloqueadoMed.toString(),
            bloqueadoManual: usuario.saldo.saldoBloqueadoManual.toString(),
          }
        : null,
      /**
       * Regras que explicam os saldos parados: sem elas o cliente vê "A liberar"
       * e "Reservado" sem saber por quê — e vê "Bloqueado MED" numa conta que
       * sequer bloqueia por MED.
       */
      regras: {
        diasLiberacaoSaldo: cfg?.diasLiberacaoSaldo ?? 0,
        percentualReserva: (cfg?.percentualReserva ?? 0).toString(),
        diasRetencaoReserva: cfg?.diasRetencaoReserva ?? 0,
        medBloqueiaSaldo:
          (cfg?.modoTratamentoMed ?? MODO_TRATAMENTO_MED.BLOQUEAR_SALDO) ===
          MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
        ticketMinimoPixSaida: (cfg?.ticketMinimoPixSaida ?? 0).toString(),
        ticketMaximoPixSaida: cfg?.ticketMaximoPixSaida?.toString() ?? null,
      },
    };

    const periodo = {
      inicio: janela.desde,
      fim: janela.ate,
      dias: Math.max(
        1,
        Math.round((janela.ate.getTime() - janela.desde.getTime()) / 86_400_000),
      ),
    };

    // Sem linha de saldo (conta nova, ainda sem crédito) o snapshot é zero —
    // mas as cobranças JÁ existem. Cortar aqui zerava Gerados/recentes mesmo
    // com PIX aguardando pagamento no extrato.
    const whereEntrada = {
      usuarioId,
      direcao: 'ENTRADA' as const,
      criadoEm: { gte: janela.desde },
    };

    // Janela anterior de mesma duração, para o comparativo do painel.
    const whereEntradaAnterior = {
      usuarioId,
      direcao: 'ENTRADA' as const,
      criadoEm: { gte: janela.desdeAnterior, lt: janela.desde },
    };

    const [
      geradas,
      aprovadas,
      recentes,
      linhas,
      geradasAnt,
      aprovadasAnt,
    ] = await Promise.all([
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
        where: { usuarioId, direcao: 'ENTRADA' },
        orderBy: { criadoEm: 'desc' },
        take: 10,
        include: { pix: true, itens: { orderBy: { id: 'asc' } } },
      }),
      this.prisma.transacao.findMany({
        where: whereEntrada,
        select: { criadoEm: true, valorBruto: true, situacao: true },
        take: 20000,
      }),
      this.prisma.transacao.aggregate({
        where: whereEntradaAnterior,
        _sum: { valorBruto: true },
        _count: true,
      }),
      this.prisma.transacao.aggregate({
        where: {
          ...whereEntradaAnterior,
          situacao: { in: SITUACOES_APROVADAS as never },
        },
        _sum: { valorBruto: true },
        _count: true,
      }),
    ]);

    // Série contínua: um ponto por balde da janela, zeros inclusive.
    // 1d honra `intervalo` (1h/30m/15m); 7d/30d/mês ignoram e vão por dia.
    const serie = montarSerieDashboard({
      desde: janela.desde,
      ate: janela.ate,
      porHora: janela.porHora,
      intervalo: intervaloSerie,
      linhas,
    });

    const geradasQtd = Number(geradas._count ?? 0);
    const aprovadasQtd = Number(aprovadas._count ?? 0);
    const geradasValor = Number((geradas._sum?.valorBruto ?? 0).toString());
    const aprovadasValor = Number((aprovadas._sum?.valorBruto ?? 0).toString());
    const ticketMedio = aprovadasQtd > 0 ? aprovadasValor / aprovadasQtd : 0;
    const conversao = geradasQtd > 0 ? aprovadasQtd / geradasQtd : 0;

    const geradasQtdAnt = Number(geradasAnt._count ?? 0);
    const aprovadasQtdAnt = Number(aprovadasAnt._count ?? 0);
    const geradasValorAnt = Number((geradasAnt._sum?.valorBruto ?? 0).toString());
    const aprovadasValorAnt = Number(
      (aprovadasAnt._sum?.valorBruto ?? 0).toString(),
    );

    return {
      conta,
      range: janela.range,
      intervalo: janela.porHora ? intervaloSerie : '1d',
      periodo,
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
      anterior: {
        gerados: geradasValorAnt.toFixed(2),
        pagos: aprovadasValorAnt.toFixed(2),
        geradasQtd: geradasQtdAnt,
        aprovadasQtd: aprovadasQtdAnt,
        ticketMedio: (aprovadasQtdAnt > 0
          ? aprovadasValorAnt / aprovadasQtdAnt
          : 0
        ).toFixed(2),
        conversao: geradasQtdAnt > 0 ? aprovadasQtdAnt / geradasQtdAnt : 0,
      },
      serie,
      recentes: recentes.map((t) => ({
        idTransacao: t.idTransacaoPublico,
        cliente: t.pix?.nomePagador ?? '—',
        clienteEmail: t.pix?.emailPagador ?? null,
        produto: resumoProduto(t.itens, t.referenciaExterna),
        valor: t.valorBruto.toString(),
        situacao: t.situacao,
        criadoEm: t.criadoEm,
      })),
    };
  }
}
