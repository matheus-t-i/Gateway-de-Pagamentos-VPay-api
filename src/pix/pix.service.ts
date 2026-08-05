import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { decryptCredentials } from '../common/crypto.util';
import { getRastreio } from '../common/request-context';
import {
  ContingenciaService,
  FalhaAdquirenteError,
} from '../contingencia/contingencia.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChargeResult } from '../providers/payment-provider.port';
import { AdquirentesService } from '../providers/adquirentes.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { QueuesService } from '../queues/queues.service';
import {
  CriarCobrancaPixInput,
  CriarSaquePixInput,
  ItemCobrancaInput,
  money,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  TIPO_FALHA_ADQUIRENTE,
} from '../shared';

/** Conta de adquirente com o que a criação da cobrança precisa saber dela. */
type ContaParaCobranca = {
  id: bigint;
  credenciaisCriptografadas: string;
  provedor: { codigo: string };
  custoPix: {
    custoPixEntradaPercentual: unknown;
    custoPixEntradaFixo: unknown;
  } | null;
};

@Injectable()
export class PixService {
  private readonly log = new Logger(PixService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configPix: ConfigPixService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderRegistry,
    private readonly queues: QueuesService,
    private readonly contingencia: ContingenciaService,
    private readonly adquirentes: AdquirentesService,
  ) {}

  /** Credenciais da conta; contas antigas ainda guardam JSON em claro. */
  private credenciaisDa(conta: { credenciaisCriptografadas: string }) {
    try {
      return decryptCredentials(conta.credenciaisCriptografadas);
    } catch {
      return JSON.parse(conta.credenciaisCriptografadas) as Record<string, unknown>;
    }
  }

  private custosDa(conta: ContaParaCobranca) {
    return {
      custoPct: money(conta.custoPix?.custoPixEntradaPercentual?.toString() ?? '0'),
      custoFixo: money(conta.custoPix?.custoPixEntradaFixo?.toString() ?? '0'),
    };
  }

  /**
   * Uma linha por tentativa em `tentativas_transacoes` — inclusive as que
   * falharam, que antes não eram registradas. É o rastro por transação; a
   * visão agregada por adquirente fica em `falhas_adquirente`.
   */
  private async registrarTentativa(p: {
    transacaoId: bigint;
    contaProvedorId: bigint;
    numero: number;
    situacao: string;
    idTransacaoLiquidante?: string;
    dadosResposta?: unknown;
    mensagemErro?: string;
    latenciaMs?: number;
  }) {
    try {
      await this.prisma.tentativaTransacao.create({
        data: {
          transacaoId: p.transacaoId,
          contaProvedorId: p.contaProvedorId,
          numeroTentativa: p.numero,
          situacao: p.situacao,
          idTransacaoLiquidante: p.idTransacaoLiquidante,
          dadosResposta: (p.dadosResposta ?? undefined) as never,
          mensagemErro: p.mensagemErro?.slice(0, 2000),
          latenciaMs: p.latenciaMs,
          concluidoEm: new Date(),
        },
      });
    } catch (e) {
      this.log.error(`Falha ao registrar tentativa: ${(e as Error).message}`);
    }
  }

  async criarCobranca(params: {
    usuarioId: bigint;
    // Opcional: depósito pelo PAINEL (JWT) não tem credencial de API.
    credencialApiId?: bigint;
    /**
     * `itens` é obrigatório na API pública (venda) e ausente no depósito do
     * painel (o lojista adicionando saldo para si) — por isso opcional aqui.
     */
    input: Omit<CriarCobrancaPixInput, 'itens'> & { itens?: ItemCobrancaInput[] };
    /**
     * Desliga a cadeia de contingência para esta chamada. Existe para o
     * reprocessamento manual, quando o operador quer testar UMA adquirente e
     * ver o erro dela, sem que a venda escorregue para outra.
     */
    pularContingencia?: boolean;
  }) {
    const valor = money(params.input.valor);
    const cfg = await this.configPix.resolverEfetiva(params.usuarioId);

    if (valor.lt(cfg.ticketMinimoPixEntrada) || valor.gt(cfg.ticketMaximoPixEntrada)) {
      throw new BadRequestException('Valor fora do ticket permitido');
    }

    const conta = await this.prisma.contaProvedor.findUniqueOrThrow({
      where: { id: cfg.contaProvedorPixEntradaId },
      include: { provedor: true, custoPix: true },
    });
    if (
      conta.situacao !== SITUACAO_PROVEDOR.ATIVO ||
      conta.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new BadRequestException('Provedor/conta indisponível');
    }
    if (!conta.provedor.permitePixEntrada || !conta.pixEntradaHabilitado) {
      throw new BadRequestException('PIX entrada desabilitado nesta conta');
    }
    // Defesa em profundidade: a troca forçada já remaneja quem usa uma
    // adquirente que sai de circulação, mas nenhuma cobrança pode sair por uma
    // adquirente que este cliente não está autorizado a usar.
    if (!(await this.adquirentes.estaLiberada(params.usuarioId, conta.provedorPagamentoId))) {
      throw new BadRequestException(
        'Adquirente de PIX in indisponível para esta conta — selecione outra no painel.',
      );
    }

    const { custoPct, custoFixo } = this.custosDa(conta);
    const snap = this.configPix.calcularSnapshotsEntrada(valor, cfg, custoPct, custoFixo);

    const liberarSaldoEm = new Date();
    liberarSaldoEm.setDate(liberarSaldoEm.getDate() + cfg.diasLiberacaoSaldo);
    const liberarReservaEm = new Date();
    liberarReservaEm.setDate(liberarReservaEm.getDate() + cfg.diasRetencaoReserva);

    // Total por item persistido no momento da venda — mudança de preço no
    // catálogo do lojista não pode reescrever o histórico.
    const itens = (params.input.itens ?? []).map((i) => {
      const unitario = money(String(i.valorUnitario));
      return {
        titulo: i.titulo,
        quantidade: i.quantidade,
        tangivel: i.tangivel,
        valorUnitario: unitario.toFixed(2),
        valorTotal: unitario.mul(i.quantidade).toDecimalPlaces(2).toFixed(2),
      };
    });

    const tx = await this.prisma.transacao.create({
      data: {
        usuarioId: params.usuarioId,
        credencialApiId: params.credencialApiId ?? null,
        contaProvedorId: conta.id,
        referenciaExterna: params.input.referenciaExterna,
        urlCallback: params.input.urlCallback,
        direcao: 'ENTRADA',
        valorBruto: valor.toFixed(2),
        tarifaPixPercentualAplicada: cfg.taxaPixEntradaPercentual.toFixed(4),
        tarifaPixFixaAplicada: cfg.taxaPixEntradaFixa.toFixed(4),
        valorTarifaPix: snap.valorTarifa.toFixed(2),
        custoPixProvedorPercentualAplicado: custoPct.toFixed(4),
        custoPixProvedorFixoAplicado: custoFixo.toFixed(4),
        valorCustoPixProvedor: snap.valorCusto.toFixed(2),
        valorLiquidacaoEmpresa: snap.valorLiquidacao.toFixed(2),
        valorReserva: snap.valorReserva.toFixed(2),
        valorDisponivelPrevisto: snap.valorDisponivel.toFixed(2),
        valorMargemBruta: snap.margem.toFixed(2),
        diasLiberacaoSaldoAplicado: cfg.diasLiberacaoSaldo,
        percentualReservaAplicado: cfg.percentualReserva.toFixed(4),
        baseCalculoReservaAplicada: cfg.baseCalculoReserva,
        diasRetencaoReservaAplicado: cfg.diasRetencaoReserva,
        liberarSaldoEm,
        liberarReservaEm,
        situacao: SITUACAO_TRANSACAO.PROCESSANDO,
        pix: {
          create: {
            nomePagador: params.input.pagador?.nome,
            documentoPagador: params.input.pagador?.documento,
            emailPagador: params.input.pagador?.email,
            telefonePagador: params.input.pagador?.telefone,
            enderecoPagador: params.input.pagador?.endereco ?? undefined,
          },
        },
        ...(itens.length ? { itens: { create: itens } } : {}),
      },
    });

    /**
     * Corrida contra o relógio: a adquirente do lojista primeiro, depois a
     * cadeia de contingência. O objetivo é NÃO PERDER A VENDA — o pagador não
     * pode ficar sem código PIX porque uma liquidante caiu.
     *
     * A cadeia é percorrida em laço (e não por recursão em `criarCobranca`)
     * para reaproveitar a MESMA transação: recriar a venda a cada tentativa
     * duplicaria o registro e furaria a idempotência por `referenciaExterna`.
     */
    const cadeia = params.pularContingencia ? [] : await this.contingencia.cadeia();
    const tentativas = [
      { ordem: 0, conta: conta as ContaParaCobranca },
      ...cadeia
        .filter((c) => c.conta.id !== conta.id)
        .map((c) => ({ ordem: c.ordem, conta: c.conta as ContaParaCobranca })),
    ];

    const dadosRequisicao = {
      idTransacaoPrivado: tx.idTransacaoPrivado,
      idTransacaoPublico: tx.idTransacaoPublico,
      valor: valor.toFixed(2),
      referenciaExterna: params.input.referenciaExterna,
      expiracaoSegundos: params.input.expiracaoSegundos,
    };

    let vencedora: { conta: ContaParaCobranca; charge: CreateChargeResult; ordem: number } | null =
      null;
    let ultimoErro: unknown = null;

    for (const tentativa of tentativas) {
      const inicio = Date.now();
      try {
        const provider = this.providers.get(tentativa.conta.provedor.codigo);
        const charge = await this.contingencia.executarComTimeout(() =>
          provider.createCharge({
            valor,
            idTransacaoPrivado: tx.idTransacaoPrivado,
            idTransacaoPublico: tx.idTransacaoPublico,
            referenciaExterna: params.input.referenciaExterna,
            pagador: params.input.pagador,
            itens: params.input.itens,
            expiracaoSegundos: params.input.expiracaoSegundos,
            credenciais: this.credenciaisDa(tentativa.conta),
          }),
        );
        // 200 sem código PIX é falha: o pagador não tem o que copiar.
        if (!charge?.pixCopiaCola) {
          throw new FalhaAdquirenteError(
            TIPO_FALHA_ADQUIRENTE.SEM_CODIGO_PIX,
            'Adquirente respondeu sem código PIX (copia e cola vazio)',
            { dadosResposta: charge?.raw },
          );
        }
        vencedora = { conta: tentativa.conta, charge, ordem: tentativa.ordem };
        await this.registrarTentativa({
          transacaoId: tx.id,
          contaProvedorId: tentativa.conta.id,
          numero: tentativa.ordem + 1,
          situacao: SITUACAO_TENTATIVA.SUCESSO,
          idTransacaoLiquidante: charge.idTransacaoLiquidante,
          dadosResposta: charge.raw,
          latenciaMs: Date.now() - inicio,
        });
        break;
      } catch (erro) {
        ultimoErro = erro;
        const latenciaMs = Date.now() - inicio;
        const tipo = ContingenciaService.classificar(erro);
        this.log.warn(
          `Adquirente ${tentativa.conta.provedor.codigo} falhou (${tipo}) na tx ` +
            `${tx.idTransacaoPublico}: ${(erro as Error).message}`,
        );
        await this.contingencia.registrarFalha({
          transacaoId: tx.id,
          usuarioId: params.usuarioId,
          contaProvedorId: tentativa.conta.id,
          tipo,
          ordemTentativa: tentativa.ordem,
          erro,
          dadosRequisicao,
          latenciaMs,
        });
        await this.registrarTentativa({
          transacaoId: tx.id,
          contaProvedorId: tentativa.conta.id,
          numero: tentativa.ordem + 1,
          situacao: SITUACAO_TENTATIVA.FALHA,
          mensagemErro: (erro as Error).message,
          latenciaMs,
        });
      }
    }

    if (!vencedora) {
      // Nem a contingência salvou: a venda foi perdida e a transação não pode
      // ficar PROCESSANDO para sempre.
      await this.prisma.$transaction([
        this.prisma.transacao.update({
          where: { id: tx.id },
          data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
        }),
        this.prisma.historicoSituacaoTransacao.create({
          data: {
            transacaoId: tx.id,
            situacaoAnterior: SITUACAO_TRANSACAO.PROCESSANDO,
            novaSituacao: SITUACAO_TRANSACAO.FALHA,
            origem: 'API',
            motivo: `Nenhuma adquirente gerou a cobrança (${tentativas.length} tentativa(s))`,
          },
        }),
      ]);
      throw new ServiceUnavailableException(
        'Não foi possível gerar a cobrança em nenhuma adquirente. ' +
          `Último erro: ${(ultimoErro as Error)?.message ?? 'desconhecido'}`,
      );
    }

    const charge = vencedora.charge;

    // A venda saiu por outra adquirente: o custo é o DELA. Sem reescrever o
    // snapshot, a margem e o custo do provedor ficariam com os números da
    // adquirente que falhou.
    if (vencedora.conta.id !== conta.id) {
      const custos = this.custosDa(vencedora.conta);
      const novo = this.configPix.calcularSnapshotsEntrada(
        valor,
        cfg,
        custos.custoPct,
        custos.custoFixo,
      );
      await this.prisma.transacao.update({
        where: { id: tx.id },
        data: {
          contaProvedorId: vencedora.conta.id,
          custoPixProvedorPercentualAplicado: custos.custoPct.toFixed(4),
          custoPixProvedorFixoAplicado: custos.custoFixo.toFixed(4),
          valorCustoPixProvedor: novo.valorCusto.toFixed(2),
          valorLiquidacaoEmpresa: novo.valorLiquidacao.toFixed(2),
          valorReserva: novo.valorReserva.toFixed(2),
          valorDisponivelPrevisto: novo.valorDisponivel.toFixed(2),
          valorMargemBruta: novo.margem.toFixed(2),
        },
      });
      await this.contingencia.marcarResolvidas(tx.id, vencedora.conta.id);
    }

    await this.prisma.$transaction([
      this.prisma.transacaoPix.update({
        where: { transacaoId: tx.id },
        data: {
          txid: charge.txid,
          pixCopiaCola: charge.pixCopiaCola,
          urlCheckout: charge.urlCheckout,
          expiraEm: charge.expiraEm,
        },
      }),
      this.prisma.transacao.update({
        where: { id: tx.id },
        data: { situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO },
      }),
      this.prisma.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: SITUACAO_TRANSACAO.PROCESSANDO,
          novaSituacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
          origem: 'API',
          motivo:
            vencedora.ordem === 0
              ? 'Cobrança criada na liquidante'
              : `Cobrança criada na contingência #${vencedora.ordem}`,
        },
      }),
    ]);

    // `idInterno` fica só para uso do controller (idempotência) e é removido
    // antes da resposta — a API pública conhece apenas `idTransacao`.
    return {
      idInterno: tx.id.toString(),
      idTransacao: tx.idTransacaoPublico,
      situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
      valor: valor.toFixed(2),
      pixCopiaCola: charge.pixCopiaCola,
      urlCheckout: charge.urlCheckout,
      txid: charge.txid,
      expiraEm: charge.expiraEm,
    };
  }

  async criarSaque(params: {
    usuarioId: bigint;
    /** Ausente quando o saque é solicitado pelo painel (sem credencial de API). */
    credencialApiId?: bigint;
    input: CriarSaquePixInput;
  }) {
    const valor = money(params.input.valor);
    const cfg = await this.configPix.resolverEfetiva(params.usuarioId);
    if (!cfg.permitirPixSaidaViaApi) {
      throw new BadRequestException('PIX saída via API desabilitado');
    }
    if (valor.lt(cfg.ticketMinimoPixSaida)) {
      throw new BadRequestException('Valor abaixo do mínimo');
    }
    if (cfg.ticketMaximoPixSaida && valor.gt(cfg.ticketMaximoPixSaida)) {
      throw new BadRequestException('Valor acima do máximo');
    }

    const conta = await this.prisma.contaProvedor.findUniqueOrThrow({
      where: { id: cfg.contaProvedorPixSaidaId },
      include: { provedor: true, custoPix: true },
    });
    if (
      conta.situacao !== SITUACAO_PROVEDOR.ATIVO ||
      conta.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new BadRequestException('Provedor/conta indisponível');
    }

    const custoPct = money(conta.custoPix?.custoPixSaidaPercentual?.toString() ?? '0');
    const custoFixo = money(conta.custoPix?.custoPixSaidaFixo?.toString() ?? '0');
    const valorTarifa = valor.mul(cfg.taxaPixSaidaPercentual).div(100).plus(cfg.taxaPixSaidaFixa).toDecimalPlaces(2);
    const valorCusto = valor.mul(custoPct).div(100).plus(custoFixo).toDecimalPlaces(2);
    const totalDebito = valor.plus(valorTarifa);

    await this.ledger.aplicarMovimentacoes({
      usuarioId: params.usuarioId,
      permiteSaldoNegativo: cfg.permiteSaldoNegativo,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'SAIDA',
          valor,
          chaveIdempotencia: `saque:hold:${params.usuarioId}:${params.input.referenciaExterna ?? randomUUID()}`,
          descricao: 'Reserva de valor para saque PIX',
        },
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'TARIFA',
          valor: valorTarifa,
          chaveIdempotencia: `saque:tarifa:${params.usuarioId}:${params.input.referenciaExterna ?? randomUUID()}`,
          descricao: 'Tarifa saque PIX',
        },
      ],
    });

    const tx = await this.prisma.transacao.create({
      data: {
        usuarioId: params.usuarioId,
        credencialApiId: params.credencialApiId,
        contaProvedorId: conta.id,
        referenciaExterna: params.input.referenciaExterna,
        urlCallback: params.input.urlCallback,
        direcao: 'SAIDA',
        valorBruto: valor.toFixed(2),
        tarifaPixPercentualAplicada: cfg.taxaPixSaidaPercentual.toFixed(4),
        tarifaPixFixaAplicada: cfg.taxaPixSaidaFixa.toFixed(4),
        valorTarifaPix: valorTarifa.toFixed(2),
        custoPixProvedorPercentualAplicado: custoPct.toFixed(4),
        custoPixProvedorFixoAplicado: custoFixo.toFixed(4),
        valorCustoPixProvedor: valorCusto.toFixed(2),
        valorLiquidacaoEmpresa: totalDebito.neg().toFixed(2),
        valorMargemBruta: valorTarifa.minus(valorCusto).toFixed(2),
        situacao: SITUACAO_TRANSACAO.PROCESSANDO,
        pix: {
          create: {
            chavePix: params.input.chavePix,
            tipoChavePix: params.input.tipoChavePix,
            nomeBeneficiario: params.input.nomeBeneficiario,
            documentoBeneficiario: params.input.documentoBeneficiario,
          },
        },
      },
    });

    await this.queues.enqueuePixCashOut({
      provider: conta.provedor.codigo,
      contaProvedorId: conta.id.toString(),
      payload: {
        transacaoId: tx.id.toString(),
        idTransacaoPrivado: tx.idTransacaoPrivado,
      },
      identificadorRastreio: getRastreio(),
    });

    return {
      idInterno: tx.id.toString(),
      idTransacao: tx.idTransacaoPublico,
      situacao: SITUACAO_TRANSACAO.PROCESSANDO,
      valor: valor.toFixed(2),
    };
  }

  async listar(usuarioId: bigint) {
    const rows = await this.prisma.transacao.findMany({
      where: { usuarioId },
      orderBy: { criadoEm: 'desc' },
      take: 100,
      include: { pix: true },
    });
    return rows.map((t) => ({
      idTransacao: t.idTransacaoPublico,
      direcao: t.direcao,
      situacao: t.situacao,
      valorBruto: t.valorBruto.toString(),
      valorLiquidacao: t.valorLiquidacaoEmpresa.toString(),
      criadoEm: t.criadoEm,
      pixCopiaCola: t.pix?.pixCopiaCola,
    }));
  }

  async detalhe(idTransacao: string, usuarioId: bigint) {
    const t = await this.prisma.transacao.findFirst({
      where: { idTransacaoPublico: idTransacao, usuarioId },
      // `tentativas` NÃO entra: nada na resposta usa, e cada linha carrega o
      // response cru da liquidante — seria um JOIN de JSON grande em toda
      // consulta de transação, além de risco de vazar dado interno se algum dia
      // alguém mapear o campo sem pensar.
      include: { pix: true, itens: { orderBy: { id: 'asc' } } },
    });
    if (!t) throw new BadRequestException('Transação não encontrada');
    return {
      idTransacao: t.idTransacaoPublico,
      direcao: t.direcao,
      situacao: t.situacao,
      valorBruto: t.valorBruto.toString(),
      valorTarifa: t.valorTarifaPix.toString(),
      valorLiquidacao: t.valorLiquidacaoEmpresa.toString(),
      valorReserva: t.valorReserva.toString(),
      // Campos PIX mapeados explicitamente — nunca vazar ids internos.
      pix: t.pix
        ? {
            txid: t.pix.txid,
            pixCopiaCola: t.pix.pixCopiaCola,
            urlCheckout: t.pix.urlCheckout,
            expiraEm: t.pix.expiraEm,
            chavePix: t.pix.chavePix,
            tipoChavePix: t.pix.tipoChavePix,
            nomePagador: t.pix.nomePagador,
            nomeBeneficiario: t.pix.nomeBeneficiario,
            enderecoPagador: t.pix.enderecoPagador ?? null,
          }
        : null,
      itens: t.itens.map((i) => ({
        titulo: i.titulo,
        quantidade: i.quantidade,
        valorUnitario: i.valorUnitario.toString(),
        valorTotal: i.valorTotal.toString(),
        tangivel: i.tangivel,
      })),
      criadoEm: t.criadoEm,
      liquidadoEm: t.liquidadoEm,
    };
  }
}
