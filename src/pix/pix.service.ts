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
import { IntegracoesService } from '../integracoes/integracoes.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChargeResult } from '../providers/payment-provider.port';
import { AdquirentesService } from '../providers/adquirentes.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { QueuesService } from '../queues/queues.service';
import {
  CriarCobrancaPixInput,
  CriarSaquePixInput,
  EVENTOS_INTEGRACAO,
  ItemCobrancaInput,
  money,
  resumoProduto,
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  TIPO_FALHA_ADQUIRENTE,
} from '../shared';

/** Filtros do extrato do painel — mesmos para a lista e para o resumo. */
type FiltroExtrato = {
  direcao?: string;
  situacao?: string;
  dataInicial?: string;
  dataFinal?: string;
  busca?: string;
};
type Paginacao = { page?: string; limit?: string };

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
    private readonly integracoes: IntegracoesService,
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
        // Origem da venda (utm_*). Guardado na criação porque é o único momento
        // em que o checkout do lojista sabe de onde veio o comprador — depois
        // não há como recuperar. Só os apps conectados leem isto.
        parametrosRastreio: params.input.rastreio ?? undefined,
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
        // Nasce AGUARDANDO_PAGAMENTO: a criação só tem dois desfechos — sai com
        // código PIX (segue aguardando o pagador) ou não sai de nenhuma
        // adquirente (vira FALHA logo abaixo). Um PROCESSANDO intermediário
        // custaria um UPDATE e um histórico a mais no caminho feliz sem contar
        // nada a quem acompanha a cobrança.
        situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
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
      // ficar AGUARDANDO_PAGAMENTO sem código PIX nenhum para o pagador.
      await this.prisma.$transaction([
        this.prisma.transacao.update({
          where: { id: tx.id },
          data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
        }),
        this.prisma.historicoSituacaoTransacao.create({
          data: {
            transacaoId: tx.id,
            situacaoAnterior: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
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

    // A situação já é AGUARDANDO_PAGAMENTO desde a criação — o que faltava era
    // o código PIX. O histórico com `situacaoAnterior: null` registra o estado
    // inicial e, sobretudo, QUAL adquirente atendeu.
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
      this.prisma.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: null,
          novaSituacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
          origem: 'API',
          motivo:
            vencedora.ordem === 0
              ? 'Cobrança criada na liquidante'
              : `Cobrança criada na contingência #${vencedora.ordem}`,
        },
      }),
    ]);

    // Apps conectados pelo lojista (Utmify e afins) recebem o "PIX gerado".
    // Fora de qualquer transação e sem poder lançar: rastreio de campanha não
    // pode atrasar nem derrubar a entrega do código PIX ao pagador.
    await this.integracoes.notificarSemFalhar(
      tx.id,
      EVENTOS_INTEGRACAO.PEDIDO_CRIADO,
    );

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

    // Origem permitida: quem tem credencial de API veio pela API; sem ela, veio
    // do painel. O padrão do sistema é PAINEL — API é liberação explícita.
    const viaApi = !!params.credencialApiId;
    const origemLiberada =
      cfg.origemSaquePermitida === 'AMBOS' ||
      (viaApi ? cfg.origemSaquePermitida === 'API' : cfg.origemSaquePermitida === 'PAINEL');
    if (!origemLiberada) {
      throw new BadRequestException(
        viaApi
          ? 'Saque via API não está habilitado para esta conta.'
          : 'Saque pelo painel não está habilitado para esta conta.',
      );
    }

    // Chave de destino: quando a conta exige chave cadastrada, o saque só sai
    // para chave APROVADA do próprio titular — é o que impede desviar dinheiro
    // para uma chave qualquer com a credencial vazada.
    if (cfg.exigirChavePixCadastrada) {
      const chave = await this.prisma.chavePixUsuario.findFirst({
        where: {
          usuarioId: params.usuarioId,
          chave: params.input.chavePix,
          situacao: SITUACAO_CHAVE_PIX.APROVADA,
        },
      });
      if (!chave) {
        throw new BadRequestException(
          'Esta conta só permite saque para chave PIX cadastrada e aprovada. ' +
            'Cadastre a chave no painel e aguarde a aprovação.',
        );
      }
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

    /**
     * Saque NUNCA usa saldo negativo, nem em conta que permite ficar negativa.
     *
     * "Conta pode ficar negativa" existe para o dinheiro que a adquirente leva
     * de volta (MED): a dívida é consequência de algo que já aconteceu. Saque é
     * o contrário — é a conta pedindo dinheiro que ela não tem, e quem pagaria
     * seria a VPay, sem nenhuma garantia de reaver. Este débito é a ÚNICA trava
     * de saldo do saque: não existe outra checagem antes daqui.
     */
    // As duas chaves ficam em variável porque o vínculo com a transação é feito
    // logo abaixo, por elas — a transação ainda não existe neste ponto.
    const referenciaDebito = params.input.referenciaExterna ?? randomUUID();
    const chaveHold = `saque:hold:${params.usuarioId}:${referenciaDebito}`;
    const chaveTarifa = `saque:tarifa:${params.usuarioId}:${referenciaDebito}`;

    await this.ledger.aplicarMovimentacoes({
      usuarioId: params.usuarioId,
      permiteSaldoNegativo: false,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'SAIDA',
          valor,
          chaveIdempotencia: chaveHold,
          descricao: 'Reserva de valor para saque PIX',
        },
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'TARIFA',
          valor: valorTarifa,
          chaveIdempotencia: chaveTarifa,
          descricao: 'Tarifa saque PIX',
        },
      ],
    });

    /**
     * Transação + vínculo das movimentações no MESMO commit.
     *
     * O `PixCashOutProcessor` revalida o débito somando
     * `movimentacoes_saldo` POR `transacao_id` antes de mandar dinheiro para a
     * liquidante. As movimentações nascem sem esse vínculo (o débito acontece
     * antes da transação existir, de propósito), então sem este `updateMany` a
     * soma dava zero e TODO saque parava na revalidação — com o saldo do
     * lojista já debitado e a transação presa em `PROCESSANDO`.
     *
     * Atômico porque uma falha entre o `create` e o vínculo recriaria
     * exatamente esse estado.
     */
    const tx = await this.prisma.$transaction(async (db) => {
      const criada = await db.transacao.create({
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
      await db.movimentacaoSaldo.updateMany({
        where: {
          chaveIdempotencia: { in: [chaveHold, chaveTarifa] },
          usuarioId: params.usuarioId,
          transacaoId: null,
        },
        data: { transacaoId: criada.id },
      });
      return criada;
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

  /**
   * Filtro do extrato, compartilhado pela LISTA e pelo RESUMO — os dois têm de
   * enxergar exatamente o mesmo conjunto, senão o total do topo não bate com a
   * tabela.
   */
  private async filtroExtrato(usuarioId: bigint, q: FiltroExtrato) {
    const direcao =
      q.direcao === 'ENTRADA' || q.direcao === 'SAIDA' ? q.direcao : undefined;

    const where: Record<string, unknown> = { usuarioId };
    if (direcao) where.direcao = direcao;
    // Situação só entra se for do vocabulário oficial — valor inventado na query
    // string devolveria lista vazia sem explicação.
    if (q.situacao && q.situacao in SITUACAO_TRANSACAO) where.situacao = q.situacao;
    if (q.dataInicial || q.dataFinal) {
      const gte = q.dataInicial ? new Date(q.dataInicial + 'T00:00:00') : undefined;
      const lte = q.dataFinal ? new Date(q.dataFinal + 'T23:59:59.999') : undefined;
      where.criadoEm = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
    }

    const busca = (q.busca ?? '').trim();
    if (busca) {
      const orBusca: Array<Record<string, unknown>> = [
        { referenciaExterna: { contains: busca, mode: 'insensitive' } },
        {
          pix: {
            is: { identificadorFimAFim: { contains: busca, mode: 'insensitive' } },
          },
        },
        { pix: { is: { txid: { contains: busca, mode: 'insensitive' } } } },
      ];

      /**
       * A tabela mostra o id ABREVIADO (#6147dbe2), então o que o lojista copia
       * da tela é um PREFIXO — e `id_transacao_publico` é UUID, tipo em que o
       * Postgres não faz LIKE. Resolve com cast em SQL cru, sempre preso ao
       * `usuario_id` do JWT para não virar sonda de transação alheia.
       */
      const prefixo = busca.toLowerCase().replace(/[^0-9a-f-]/g, '');
      if (prefixo.length >= 4) {
        const achados = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM transacoes
          WHERE usuario_id = ${usuarioId}
            AND id_transacao_publico::text LIKE ${prefixo + '%'}
          LIMIT 5000
        `;
        if (achados.length) orBusca.push({ id: { in: achados.map((r) => r.id) } });
      }

      where.OR = orBusca;
    }

    return { where, direcao };
  }

  /**
   * Uma PÁGINA do extrato. Custo constante: índice + `LIMIT` — trocar de página
   * não conta nem soma nada, esse trabalho é do `resumo`, que só refaz quando o
   * FILTRO muda.
   *
   * `direcao` é o que separa as duas telas do painel: Transações (ENTRADA) e
   * Transferências (SAIDA). Cada lado tem colunas próprias, então o cliente
   * nunca vê a mistura.
   */
  async listar(usuarioId: bigint, q: FiltroExtrato & Paginacao = {}) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 10));
    const { where } = await this.filtroExtrato(usuarioId, q);

    const rows = await this.prisma.transacao.findMany({
      where: where as never,
      orderBy: { criadoEm: 'desc' },
      skip: (pagina - 1) * limite,
      take: limite,
      include: { pix: true, itens: { orderBy: { id: 'asc' } } },
    });

    return {
      pagina,
      limite,
      itens: rows.map((t) => ({
        idTransacao: t.idTransacaoPublico,
        direcao: t.direcao,
        situacao: t.situacao,
        valorBruto: t.valorBruto.toString(),
        valorTarifa: t.valorTarifaPix.toString(),
        /**
         * Sempre POSITIVO e com significado próprio de cada sentido: na entrada
         * é o que sobra para o lojista (bruto − taxa); na saída é o que sai da
         * carteira (bruto + taxa). O sinal fica com o rótulo da tela, não com o
         * número — `valorLiquidacaoEmpresa` guarda a saída negativa.
         */
        valorLiquido: this.liquidoDaDirecao(
          t.direcao,
          money(t.valorBruto.toString()),
          money(t.valorTarifaPix.toString()),
        ),
        criadoEm: t.criadoEm,
        liquidadoEm: t.liquidadoEm,
        referenciaExterna: t.referenciaExterna,
        produto: resumoProduto(t.itens, t.referenciaExterna),
        itens: t.itens.map((i) => ({
          titulo: i.titulo,
          quantidade: i.quantidade,
          valorUnitario: i.valorUnitario.toString(),
          valorTotal: i.valorTotal.toString(),
          tangivel: i.tangivel,
        })),
        pagador: t.pix?.nomePagador ?? null,
        beneficiario: t.pix?.nomeBeneficiario ?? null,
        chavePix: t.pix?.chavePix ?? null,
        pixCopiaCola: t.pix?.pixCopiaCola ?? null,
        // endToEnd é o identificador que o lojista usa no suporte/conciliação.
        endToEnd: t.pix?.identificadorFimAFim ?? null,
      })),
    };
  }

  /**
   * Cabeçalho do extrato: quantas operações o filtro tem e quanto de fato
   * entrou/saiu. Consulta SEPARADA da lista de propósito — é a parte cara
   * (percorre todo o conjunto filtrado, não só a página), e assim só roda
   * quando o lojista muda o filtro, não a cada "Próxima".
   *
   * Soma só as CONCLUÍDAS: cobrança pendente não é dinheiro na conta.
   */
  async resumo(usuarioId: bigint, q: FiltroExtrato = {}) {
    const { where, direcao } = await this.filtroExtrato(usuarioId, q);

    const [quantidade, concluidas] = await Promise.all([
      this.prisma.transacao.count({ where: where as never }),
      // Agrupado por direção para o líquido sair da MESMA conta da linha
      // (bruto ∓ tarifa) — nunca de `valorLiquidacaoEmpresa`, que é o efeito no
      // ledger e tem sinal próprio.
      this.prisma.transacao.groupBy({
        by: ['direcao'],
        where: { ...where, situacao: SITUACAO_TRANSACAO.CONCLUIDA } as never,
        _count: { _all: true },
        _sum: { valorBruto: true, valorTarifaPix: true },
      }),
    ]);

    let quantidadeConcluidas = 0;
    let brutoTotal = money(0);
    let tarifaTotal = money(0);
    let liquidoTotal = money(0);
    for (const g of concluidas) {
      const bruto = money(g._sum.valorBruto?.toString() ?? '0');
      const tarifa = money(g._sum.valorTarifaPix?.toString() ?? '0');
      const liquido = money(this.liquidoDaDirecao(g.direcao, bruto, tarifa));
      quantidadeConcluidas += g._count._all;
      brutoTotal = brutoTotal.plus(bruto);
      tarifaTotal = tarifaTotal.plus(tarifa);
      // Numa tela de um sentido só, o líquido é o valor daquele sentido (sempre
      // positivo). Sem filtro de direção vira efeito no saldo: saída subtrai.
      liquidoTotal =
        !direcao && g.direcao === 'SAIDA'
          ? liquidoTotal.minus(liquido)
          : liquidoTotal.plus(liquido);
    }

    return {
      quantidade,
      quantidadeConcluidas,
      bruto: brutoTotal.toFixed(2),
      tarifa: tarifaTotal.toFixed(2),
      liquido: liquidoTotal.toFixed(2),
    };
  }

  /** Entrada: o que o lojista recebe. Saída: o que sai da carteira dele. */
  private liquidoDaDirecao(
    direcao: string,
    bruto: ReturnType<typeof money>,
    tarifa: ReturnType<typeof money>,
  ) {
    return (direcao === 'SAIDA' ? bruto.plus(tarifa) : bruto.minus(tarifa)).toFixed(2);
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
