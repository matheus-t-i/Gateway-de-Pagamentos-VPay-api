import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { decryptCredentials } from '../common/crypto.util';
import { getRastreio } from '../common/request-context';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
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
} from '../shared';

@Injectable()
export class PixService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configPix: ConfigPixService,
    private readonly ledger: LedgerService,
    private readonly providers: ProviderRegistry,
    private readonly queues: QueuesService,
  ) {}

  async criarCobranca(params: {
    empresaId: bigint;
    usuarioId: bigint;
    // Opcional: depósito pelo PAINEL (JWT) não tem credencial de API.
    credencialApiId?: bigint;
    /**
     * `itens` é obrigatório na API pública (venda) e ausente no depósito do
     * painel (o lojista adicionando saldo para si) — por isso opcional aqui.
     */
    input: Omit<CriarCobrancaPixInput, 'itens'> & { itens?: ItemCobrancaInput[] };
  }) {
    const valor = money(params.input.valor);
    const cfg = await this.configPix.resolverEfetiva(params.empresaId);

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

    const custoPct = money(conta.custoPix?.custoPixEntradaPercentual?.toString() ?? '0');
    const custoFixo = money(conta.custoPix?.custoPixEntradaFixo?.toString() ?? '0');
    const snap = this.configPix.calcularSnapshotsEntrada(valor, cfg, custoPct, custoFixo);

    const liberarSaldoEm = new Date();
    liberarSaldoEm.setDate(liberarSaldoEm.getDate() + cfg.diasLiberacaoSaldo);
    const liberarReservaEm = new Date();
    liberarReservaEm.setDate(liberarReservaEm.getDate() + cfg.diasRetencaoReserva);

    const provider = this.providers.get(conta.provedor.codigo);
    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(conta.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(conta.credenciaisCriptografadas) as Record<string, unknown>;
    }

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
        empresaId: params.empresaId,
        usuarioSolicitanteId: params.usuarioId,
        credencialApiId: params.credencialApiId ?? null,
        contaProvedorId: conta.id,
        referenciaExterna: params.input.referenciaExterna,
        urlCallback: params.input.urlCallback,
        direcao: 'ENTRADA',
        origemConfiguracao: cfg.origemConfiguracao,
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

    const charge = await provider.createCharge({
      valor,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      idTransacaoPublico: tx.idTransacaoPublico,
      referenciaExterna: params.input.referenciaExterna,
      pagador: params.input.pagador,
      itens: params.input.itens,
      expiracaoSegundos: params.input.expiracaoSegundos,
      credenciais,
    });

    await this.prisma.$transaction([
      this.prisma.tentativaTransacao.create({
        data: {
          transacaoId: tx.id,
          contaProvedorId: conta.id,
          numeroTentativa: 1,
          situacao: SITUACAO_TENTATIVA.SUCESSO,
          idTransacaoLiquidante: charge.idTransacaoLiquidante,
          dadosResposta: charge.raw as object,
          concluidoEm: new Date(),
        },
      }),
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
          motivo: 'Cobrança criada na liquidante',
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
    empresaId: bigint;
    usuarioId: bigint;
    /** Ausente quando o saque é solicitado pelo painel (sem credencial de API). */
    credencialApiId?: bigint;
    input: CriarSaquePixInput;
  }) {
    const valor = money(params.input.valor);
    const cfg = await this.configPix.resolverEfetiva(params.empresaId);
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
      empresaId: params.empresaId,
      permiteSaldoNegativo: cfg.permiteSaldoNegativo,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'SAIDA',
          valor,
          chaveIdempotencia: `saque:hold:${params.empresaId}:${params.input.referenciaExterna ?? randomUUID()}`,
          descricao: 'Reserva de valor para saque PIX',
        },
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'TARIFA',
          valor: valorTarifa,
          chaveIdempotencia: `saque:tarifa:${params.empresaId}:${params.input.referenciaExterna ?? randomUUID()}`,
          descricao: 'Tarifa saque PIX',
        },
      ],
    });

    const tx = await this.prisma.transacao.create({
      data: {
        empresaId: params.empresaId,
        usuarioSolicitanteId: params.usuarioId,
        credencialApiId: params.credencialApiId,
        contaProvedorId: conta.id,
        referenciaExterna: params.input.referenciaExterna,
        urlCallback: params.input.urlCallback,
        direcao: 'SAIDA',
        origemConfiguracao: cfg.origemConfiguracao,
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

  async listar(empresaId: bigint) {
    const rows = await this.prisma.transacao.findMany({
      where: { empresaId },
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

  async detalhe(idTransacao: string, empresaId: bigint) {
    const t = await this.prisma.transacao.findFirst({
      where: { idTransacaoPublico: idTransacao, empresaId },
      include: { pix: true, tentativas: true, itens: { orderBy: { id: 'asc' } } },
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
