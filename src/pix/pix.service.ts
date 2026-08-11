import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
import { SaqueProtecaoService } from './saque-protecao.service';
import {
  CriarCobrancaPixInput,
  CriarSaquePixInput,
  Decimal,
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
    private readonly saqueProtecao: SaqueProtecaoService,
  ) {}

  /** Credenciais da conta — só AES-GCM; JSON em claro não é mais aceito. */
  private credenciaisDa(conta: { credenciaisCriptografadas: string }) {
    return decryptCredentials(conta.credenciaisCriptografadas);
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
      // Sucesso na liquidante SEM linha local = webhook órfão (pago sem crédito).
      // Fail-closed: não devolver QR sem o vínculo.
      if (
        p.situacao === SITUACAO_TENTATIVA.SUCESSO ||
        p.idTransacaoLiquidante
      ) {
        throw e;
      }
    }
  }

  /**
   * Última transação da conta com esta `referenciaExterna`, no sentido pedido.
   *
   * A referência é ETIQUETA do lojista, não chave única: o mesmo pedido pode
   * legitimamente gerar mais de uma cobrança (carrinho mudou, QR expirou, as
   * adquirentes falharam na primeira). A decisão de reaproveitar ou criar é
   * sempre contra a MAIS RECENTE. Devolve `null` sem referência ou com
   * referência inédita — o fluxo de criação segue normal.
   */
  private async ultimaTransacaoDaReferencia(
    usuarioId: bigint,
    referenciaExterna: string | undefined,
    direcao: 'ENTRADA' | 'SAIDA',
  ) {
    if (!referenciaExterna) return null;
    return this.prisma.transacao.findFirst({
      where: { usuarioId, referenciaExterna, direcao },
      orderBy: { id: 'desc' },
      include: {
        pix: true,
        itens: { orderBy: { id: 'asc' } },
        contaProvedor: { include: { provedor: true } },
      },
    });
  }

  /**
   * Devolve o saque já existente daquela referência (retentativa) ou 409 se os
   * dados divergirem. Usado nos DOIS caminhos: o pre-check sequencial e a
   * perdedora de uma corrida (P2002 da unique parcial de saque).
   *
   * Se o débito commitou e o enqueue falhou, o cliente retenta e acharia o
   * saque em PROCESSANDO para sempre — reenfileira quando não há tentativa
   * ativa (ENVIANDO/SUCESSO).
   */
  private async replayDoSaque(
    existente: {
      id: bigint;
      idTransacaoPublico: string;
      idTransacaoPrivado: string;
      situacao: string;
      valorBruto: Prisma.Decimal;
      contaProvedorId: bigint | null;
      contaProvedor?: {
        id: bigint;
        provedor: { codigo: string };
      } | null;
      pix: {
        chavePix: string | null;
        tipoChavePix: string | null;
        nomeBeneficiario: string | null;
        documentoBeneficiario: string | null;
      } | null;
    },
    valor: Decimal,
    input: CriarSaquePixInput,
  ) {
    const mesmosDados =
      money(existente.valorBruto.toString()).eq(valor) &&
      existente.pix?.chavePix === input.chavePix &&
      existente.pix?.tipoChavePix === input.tipoChavePix &&
      existente.pix?.nomeBeneficiario === input.nomeBeneficiario &&
      existente.pix?.documentoBeneficiario === input.documentoBeneficiario;
    if (!mesmosDados) {
      throw new ConflictException(
        'referenciaExterna já usada num saque com dados diferentes. Uma retentativa ' +
          'deve repetir exatamente os mesmos dados; para um saque novo, use uma referência nova.',
      );
    }

    if (existente.situacao === SITUACAO_TRANSACAO.PROCESSANDO) {
      const ativa = await this.prisma.tentativaTransacao.findFirst({
        where: {
          transacaoId: existente.id,
          situacao: { not: SITUACAO_TENTATIVA.FALHA },
        },
        select: { id: true },
      });
      if (!ativa) {
        const codigo =
          existente.contaProvedor?.provedor.codigo ??
          (
            await this.prisma.contaProvedor.findUnique({
              where: { id: existente.contaProvedorId! },
              include: { provedor: true },
            })
          )?.provedor.codigo;
        if (codigo) {
          await this.queues.enqueuePixCashOut({
            provider: codigo,
            contaProvedorId: existente.contaProvedorId?.toString(),
            payload: {
              transacaoId: existente.id.toString(),
              idTransacaoPrivado: existente.idTransacaoPrivado,
            },
            identificadorRastreio: getRastreio(),
          });
          this.log.warn(
            `replay saque tx=${existente.id} reenfileirado (PROCESSANDO sem tentativa ativa)`,
          );
        }
      }
    }

    return {
      idInterno: existente.id.toString(),
      idTransacao: existente.idTransacaoPublico,
      // Situação ATUAL: o replay pode chegar com o saque já CONCLUIDA ou
      // FALHA (estornado) — repetir PROCESSANDO esconderia o desfecho.
      situacao: existente.situacao,
      valor: money(existente.valorBruto.toString()).toFixed(2),
    };
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

    /**
     * Idempotência por `referenciaExterna` — regra do produto: **cobrança
     * nunca responde 409 por causa da referência**; o checkout sempre termina
     * com um QR utilizável, senão a venda se perde.
     *
     * A MESMA referência com os MESMOS dados devolve a MESMA cobrança (é
     * retentativa). Qualquer diferença nos dados gera uma cobrança NOVA sob a
     * mesma referência — o pedido mudou (carrinho editado), e recusar deixaria
     * o comprador sem QR. Roda ANTES das validações de ticket/adquirente: o
     * replay não é operação nova e não pode mudar de resultado porque a
     * configuração da conta mudou no meio tempo.
     *
     * O reaproveitamento exige que a cobrança existente ainda SIRVA:
     * - CONCLUIDA/MED: a venda desta referência já foi paga — devolvê-la com a
     *   situação atual avisa o lojista, em vez de abrir uma segunda cobrança
     *   para pedido pago.
     * - AGUARDANDO_PAGAMENTO com QR dentro da validade: o replay clássico.
     * FALHA, QR expirado ou cobrança ainda sem código (1ª chamada em voo após
     * timeout no lojista) seguem para gerar uma cobrança NOVA — era exatamente
     * a venda que um 409 perderia.
     */
    const existente = await this.ultimaTransacaoDaReferencia(
      params.usuarioId,
      params.input.referenciaExterna,
      'ENTRADA',
    );
    if (existente) {
      const itensEnviados = params.input.itens ?? [];
      const mesmosDados =
        money(existente.valorBruto.toString()).eq(valor) &&
        (existente.pix?.nomePagador ?? null) === (params.input.pagador?.nome ?? null) &&
        (existente.pix?.documentoPagador ?? null) ===
          (params.input.pagador?.documento ?? null) &&
        (existente.pix?.emailPagador ?? null) === (params.input.pagador?.email ?? null) &&
        existente.itens.length === itensEnviados.length &&
        existente.itens.every((gravado, i) => {
          const enviado = itensEnviados[i];
          return (
            gravado.titulo === enviado.titulo &&
            gravado.quantidade === enviado.quantidade &&
            gravado.tangivel === enviado.tangivel &&
            // `valorUnitario` é gravado com toFixed(2), mas o schema aceita mais
            // casas — comparar contra o valor cru faria um retry byte-idêntico
            // de 19.999 (gravado 20.00) parecer "dado diferente" e gerar uma
            // cobrança nova a cada tentativa. Arredonda o enviado do MESMO jeito
            // que a criação persiste, senão a idempotência nunca casaria.
            money(gravado.valorUnitario.toString()).eq(
              money(String(enviado.valorUnitario)).toDecimalPlaces(2),
            )
          );
        });

      const jaPaga =
        existente.situacao === SITUACAO_TRANSACAO.CONCLUIDA ||
        existente.situacao === SITUACAO_TRANSACAO.MED;
      const qrUtilizavel =
        !!existente.pix?.pixCopiaCola &&
        (!existente.pix.expiraEm || existente.pix.expiraEm > new Date());
      const aguardandoComQr =
        existente.situacao === SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO && qrUtilizavel;

      if (mesmosDados && (jaPaga || aguardandoComQr)) {
        return {
          idInterno: existente.id.toString(),
          idTransacao: existente.idTransacaoPublico,
          // Situação ATUAL, não a de criação: o replay pode chegar depois do
          // pagamento, e responder AGUARDANDO_PAGAMENTO numa venda CONCLUIDA
          // faria o lojista reexibir um QR já pago.
          situacao: existente.situacao,
          valor: money(existente.valorBruto.toString()).toFixed(2),
          pixCopiaCola: existente.pix!.pixCopiaCola,
          urlCheckout: existente.pix!.urlCheckout,
          txid: existente.pix!.txid,
          expiraEm: existente.pix!.expiraEm,
        };
      }
      // Cai aqui = gera cobrança NOVA com a MESMA referência. O QR anterior
      // que ainda estiver de pé continua pagável na liquidante (não há cancel
      // no contrato das adquirentes) — cada cobrança credita só o próprio
      // pagamento, e o callback distingue pelas `idTransacao`.
    }

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
        const charge = await this.contingencia.executarComTimeout((signal) =>
          provider.createCharge({
            valor,
            idTransacaoPrivado: tx.idTransacaoPrivado,
            idTransacaoPublico: tx.idTransacaoPublico,
            pagador: params.input.pagador,
            itens: params.input.itens,
            expiracaoSegundos: params.input.expiracaoSegundos,
            credenciais: this.credenciaisDa(tentativa.conta),
            signal,
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
        try {
          await this.registrarTentativa({
            transacaoId: tx.id,
            contaProvedorId: tentativa.conta.id,
            numero: tentativa.ordem + 1,
            situacao: SITUACAO_TENTATIVA.SUCESSO,
            idTransacaoLiquidante: charge.idTransacaoLiquidante,
            dadosResposta: charge.raw,
            latenciaMs: Date.now() - inicio,
          });
        } catch (vinculoErro) {
          // Não seguir a contingência: a adquirente A já tem a cobrança.
          // Continuar geraria QR de B e deixaria A pagável sem match.
          this.log.error(
            `Vínculo local falhou após createCharge (${tentativa.conta.provedor.codigo}): ` +
              `${(vinculoErro as Error).message}`,
          );
          throw new ServiceUnavailableException(
            'Cobrança criada na liquidante mas o vínculo local falhou. ' +
              'Tente novamente em instantes; se persistir, contate o suporte.',
          );
        }
        break;
      } catch (erro) {
        if (erro instanceof ServiceUnavailableException) throw erro;
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
          // Prefixo TIMEOUT: a conciliação usa isto para alertar OPS de fantasma.
          mensagemErro:
            tipo === TIPO_FALHA_ADQUIRENTE.TIMEOUT
              ? `TIMEOUT: ${(erro as Error).message}`
              : (erro as Error).message,
          latenciaMs,
        });
        /**
         * TIMEOUT: o fetch foi abortado, mas a liquidante pode ter aceitado a
         * cobrança antes. Seguir a cadeia geraria QR em B com A pagável e
         * órfão. Para a cadeia e falha a venda — retry do lojista / suporte.
         */
        if (tipo === TIPO_FALHA_ADQUIRENTE.TIMEOUT) {
          this.log.error(
            `TIMEOUT na adquirente ${tentativa.conta.provedor.codigo} — ` +
              'cadeia de contingência interrompida (risco de cobrança fantasma)',
          );
          break;
        }
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

    /**
     * Detecção de RETENTATIVA — melhor esforço, não é a trava de dinheiro.
     *
     * Só o lojista sabe que a segunda chamada é a mesma operação, e a única
     * coisa que ele nos dá para dizer isso é a `referenciaExterna` (opcional,
     * por decisão de produto: é o id do sistema DELE). Quando vem, repetir com
     * os mesmos dados devolve o saque existente sem debitar de novo; divergir
     * é 409, porque dinheiro SAINDO com a mesma referência e dados diferentes
     * é quase certo bug do lado dele — criar a segunda ordem é como se paga
     * duas vezes. Quando NÃO vem, a chamada é tratada como saque novo.
     *
     * A integridade do nosso ledger NÃO depende disto: as chaves de
     * idempotência derivam do `idTransacaoPrivado` (id nosso) e o débito nasce
     * no mesmo commit da transação — ver `criarSaque` mais abaixo.
     */
    const existente = await this.ultimaTransacaoDaReferencia(
      params.usuarioId,
      params.input.referenciaExterna,
      'SAIDA',
    );
    if (existente) return await this.replayDoSaque(existente, valor, params.input);

    const cfg = await this.configPix.resolverEfetiva(params.usuarioId);

    // Origem permitida: quem tem credencial de API veio pela API; sem ela, veio
    // do painel. O padrão do sistema é PAINEL — API é liberação explícita.
    const viaApi = !!params.credencialApiId;
    const origemLiberada =
      cfg.origemSaquePermitida === 'AMBOS' ||
      (viaApi ? cfg.origemSaquePermitida === 'API' : cfg.origemSaquePermitida === 'PAINEL');
    if (!origemLiberada) {
      const msg = viaApi
        ? 'Saque via API não está habilitado para esta conta.'
        : 'Saque pelo painel não está habilitado para esta conta.';
      await this.saqueProtecao.registrarRecusaSaque({
        usuarioId: params.usuarioId,
        motivo: msg,
        credencialApiId: params.credencialApiId,
      });
      throw new BadRequestException(msg);
    }

    // Chave de destino:
    // - Painel: SEMPRE cadastrada e APROVADA (esta flag NÃO libera chave livre
    //   no painel — o controller do painel já escolhe por idPublico aprovado).
    // - API: se exigirChavePixCadastrada, mesma regra; se false (BAAS), aceita
    //   a chave do payload. IP allowlist já foi exigida em
    //   assertSaqueViaApiPermitido no controller da API.
    const exigeChaveCadastrada = !viaApi || cfg.exigirChavePixCadastrada;
    if (exigeChaveCadastrada) {
      const chaveDestino = await this.prisma.chavePixUsuario.findFirst({
        where: {
          usuarioId: params.usuarioId,
          chave: params.input.chavePix,
          situacao: SITUACAO_CHAVE_PIX.APROVADA,
        },
      });
      if (!chaveDestino) {
        const msg = viaApi
          ? 'Saque via API só é permitido para chave PIX cadastrada e aprovada nesta conta. ' +
            'Cadastre a chave no painel e aguarde a aprovação, ou peça ao administrador ' +
            'para liberar chave livre na API (BAAS).'
          : 'Saque só é permitido para chave PIX cadastrada e aprovada. ' +
            'Cadastre a chave no painel e aguarde a aprovação.';
        await this.saqueProtecao.registrarRecusaSaque({
          usuarioId: params.usuarioId,
          motivo: msg,
          credencialApiId: params.credencialApiId,
        });
        throw new BadRequestException(msg);
      }
    }

    if (valor.lt(cfg.ticketMinimoPixSaida)) {
      throw new BadRequestException('Valor abaixo do mínimo');
    }
    if (cfg.ticketMaximoPixSaida && valor.gt(cfg.ticketMaximoPixSaida)) {
      throw new BadRequestException('Valor acima do máximo');
    }

    try {
      await this.saqueProtecao.assertSaquePermitido({
        usuarioId: params.usuarioId,
        valor,
        cfg,
      });
    } catch (e) {
      if (e instanceof BadRequestException) {
        await this.saqueProtecao.registrarRecusaSaque({
          usuarioId: params.usuarioId,
          motivo: String(e.message),
          credencialApiId: params.credencialApiId,
        });
      }
      throw e;
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
     * Transação e débito NASCEM JUNTOS, no mesmo commit.
     *
     * A chave de idempotência do ledger deriva do `idTransacaoPrivado` — id
     * gerado por NÓS. Antes ela derivava da `referenciaExterna`, que é o id do
     * sistema do LOJISTA: a integridade do nosso dinheiro não pode depender de
     * um dado que chega de fora (e que é opcional — sem ele o código caía num
     * `randomUUID()` por chamada, ou seja, saque sem idempotência nenhuma).
     *
     * Criar a transação primeiro, dentro da MESMA transação de banco, resolve
     * três coisas de uma vez: a chave passa a ser interna e estável, as
     * movimentações já nascem com `transacao_id` (o `PixCashOutProcessor`
     * revalida o débito somando por `transacao_id`, e antes isso dependia de um
     * `updateMany` posterior) e deixa de existir a janela em que um crash
     * deixava movimentação órfã com o saldo debitado e nenhuma transação.
     *
     * Saldo insuficiente derruba o commit inteiro: nenhuma transação é gravada,
     * exatamente como antes.
     *
     * Saque NUNCA usa saldo negativo, nem em conta que permite ficar negativa.
     * "Conta pode ficar negativa" existe para o dinheiro que a adquirente leva
     * de volta (MED): a dívida é consequência de algo que já aconteceu. Saque é
     * o contrário — é a conta pedindo dinheiro que ela não tem, e quem pagaria
     * seria a VPay, sem nenhuma garantia de reaver. Este débito é a ÚNICA trava
     * de saldo do saque: não existe outra checagem antes daqui.
     */
    const criarComDebito = () =>
      this.prisma.$transaction(async (db) => {
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

      await this.ledger.aplicarMovimentacoes(
        {
          usuarioId: params.usuarioId,
          permiteSaldoNegativo: false,
          entries: [
            {
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'DEBITO',
              natureza: 'SAIDA',
              valor,
              transacaoId: criada.id,
              chaveIdempotencia: `saque:hold:${criada.idTransacaoPrivado}`,
              descricao: 'Reserva de valor para saque PIX',
            },
            {
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'DEBITO',
              natureza: 'TARIFA',
              valor: valorTarifa,
              transacaoId: criada.id,
              chaveIdempotencia: `saque:tarifa:${criada.idTransacaoPrivado}`,
              descricao: 'Tarifa saque PIX',
            },
          ],
        },
        db,
      );

      return criada;
      });

    /**
     * A corrida do bot: duas chamadas idênticas no MESMO instante passam as
     * duas pelo pre-check (read-then-write) e chegam aqui juntas. Quem decide
     * é a unique parcial `transacoes_saque_referencia_key`: a perdedora leva
     * P2002 e é tratada como o que ela é — uma retentativa. Relê a vencedora e
     * devolve o MESMO saque, sem segundo débito e sem segundo PIX.
     *
     * Sem isto o teste `saque-concorrencia.spec.ts` mostrava dois saques
     * criados, saldo debitado duas vezes e os dois indo para a fila.
     */
    let tx: Awaited<ReturnType<typeof criarComDebito>>;
    try {
      tx = await criarComDebito();
    } catch (e) {
      const violouReferencia =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        params.input.referenciaExterna;
      if (violouReferencia) {
        const vencedora = await this.ultimaTransacaoDaReferencia(
          params.usuarioId,
          params.input.referenciaExterna,
          'SAIDA',
        );
        if (vencedora) return await this.replayDoSaque(vencedora, valor, params.input);
      }
      throw e;
    }

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
