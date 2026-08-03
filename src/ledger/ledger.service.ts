import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, calcReserva, calcTarifa, money } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

export type ConfigPixEfetiva = {
  contaProvedorPixEntradaId: bigint;
  contaProvedorPixSaidaId: bigint;
  taxaPixEntradaPercentual: Decimal;
  taxaPixEntradaFixa: Decimal;
  taxaPixSaidaPercentual: Decimal;
  taxaPixSaidaFixa: Decimal;
  ticketMinimoPixEntrada: Decimal;
  ticketMaximoPixEntrada: Decimal;
  ticketMinimoPixSaida: Decimal;
  ticketMaximoPixSaida: Decimal | null;
  permitirPixSaidaViaApi: boolean;
  diasLiberacaoSaldo: number;
  percentualReserva: Decimal;
  baseCalculoReserva: 'VALOR_BRUTO' | 'VALOR_LIQUIDO_EMPRESA';
  diasRetencaoReserva: number;
  modoTratamentoMed: 'BLOQUEAR_SALDO' | 'DEBITAR_IMEDIATAMENTE' | 'ANALISE_MANUAL';
  permiteSaldoNegativo: boolean;
  origemConfiguracao: 'USUARIO' | 'EMPRESA' | 'MISTA';
};

type LedgerEntry = {
  tipoSaldo: 'DISPONIVEL' | 'PENDENTE_LIBERACAO' | 'RESERVADO' | 'BLOQUEADO_MED';
  tipoMovimento: 'CREDITO' | 'DEBITO';
  natureza:
    | 'RECEBIMENTO'
    | 'TARIFA'
    | 'RESERVA'
    | 'LIBERACAO'
    | 'SAIDA'
    | 'DEVOLUCAO_PIX'
    | 'BLOQUEIO_MED'
    | 'DESBLOQUEIO_MED'
    | 'DEBITO_MED'
    | 'AJUSTE';
  valor: Decimal;
  chaveIdempotencia: string;
  descricao?: string;
  transacaoId?: bigint;
  casoMedId?: bigint;
  devolucaoPixId?: bigint;
};

@Injectable()
export class ConfigPixService {
  constructor(private readonly prisma: PrismaService) {}

  async resolverEfetiva(empresaId: bigint): Promise<ConfigPixEfetiva> {
    const rows = await this.prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`
      SELECT
        COALESCE(e.conta_provedor_pix_entrada_id, u.conta_provedor_pix_entrada_id) AS conta_provedor_pix_entrada_id,
        COALESCE(e.conta_provedor_pix_saida_id, u.conta_provedor_pix_saida_id) AS conta_provedor_pix_saida_id,
        COALESCE(e.taxa_pix_entrada_percentual, u.taxa_pix_entrada_percentual) AS taxa_pix_entrada_percentual,
        COALESCE(e.taxa_pix_entrada_fixa, u.taxa_pix_entrada_fixa) AS taxa_pix_entrada_fixa,
        COALESCE(e.taxa_pix_saida_percentual, u.taxa_pix_saida_percentual) AS taxa_pix_saida_percentual,
        COALESCE(e.taxa_pix_saida_fixa, u.taxa_pix_saida_fixa) AS taxa_pix_saida_fixa,
        COALESCE(e.ticket_minimo_pix_entrada, u.ticket_minimo_pix_entrada) AS ticket_minimo_pix_entrada,
        COALESCE(e.ticket_maximo_pix_entrada, u.ticket_maximo_pix_entrada) AS ticket_maximo_pix_entrada,
        COALESCE(e.ticket_minimo_pix_saida, u.ticket_minimo_pix_saida) AS ticket_minimo_pix_saida,
        COALESCE(e.ticket_maximo_pix_saida, u.ticket_maximo_pix_saida) AS ticket_maximo_pix_saida,
        COALESCE(e.permitir_pix_saida_via_api, u.permitir_pix_saida_via_api) AS permitir_pix_saida_via_api,
        COALESCE(e.dias_liberacao_saldo, u.dias_liberacao_saldo) AS dias_liberacao_saldo,
        COALESCE(e.percentual_reserva, u.percentual_reserva) AS percentual_reserva,
        COALESCE(e.base_calculo_reserva, u.base_calculo_reserva) AS base_calculo_reserva,
        COALESCE(e.dias_retencao_reserva, u.dias_retencao_reserva) AS dias_retencao_reserva,
        COALESCE(e.modo_tratamento_med, u.modo_tratamento_med) AS modo_tratamento_med,
        COALESCE(e.permite_saldo_negativo, u.permite_saldo_negativo) AS permite_saldo_negativo,
        CASE WHEN e.empresa_id IS NULL THEN 'USUARIO'
             WHEN e.taxa_pix_entrada_percentual IS NOT NULL OR e.conta_provedor_pix_entrada_id IS NOT NULL THEN 'MISTA'
             ELSE 'EMPRESA' END AS origem_configuracao
      FROM empresas emp
      JOIN configuracoes_pix_usuarios u ON u.usuario_id = emp.usuario_proprietario_id
      LEFT JOIN configuracoes_pix_empresas e ON e.empresa_id = emp.id
      WHERE emp.id = ${empresaId}
    `;
    if (!rows[0]) {
      throw new BadRequestException('Configuração PIX do usuário ausente');
    }
    const r = rows[0];
    return {
      contaProvedorPixEntradaId: BigInt(String(r.conta_provedor_pix_entrada_id)),
      contaProvedorPixSaidaId: BigInt(String(r.conta_provedor_pix_saida_id)),
      taxaPixEntradaPercentual: money(String(r.taxa_pix_entrada_percentual)),
      taxaPixEntradaFixa: money(String(r.taxa_pix_entrada_fixa)),
      taxaPixSaidaPercentual: money(String(r.taxa_pix_saida_percentual)),
      taxaPixSaidaFixa: money(String(r.taxa_pix_saida_fixa)),
      ticketMinimoPixEntrada: money(String(r.ticket_minimo_pix_entrada)),
      ticketMaximoPixEntrada: money(String(r.ticket_maximo_pix_entrada)),
      ticketMinimoPixSaida: money(String(r.ticket_minimo_pix_saida)),
      ticketMaximoPixSaida: r.ticket_maximo_pix_saida
        ? money(String(r.ticket_maximo_pix_saida))
        : null,
      permitirPixSaidaViaApi: Boolean(r.permitir_pix_saida_via_api),
      diasLiberacaoSaldo: Number(r.dias_liberacao_saldo),
      percentualReserva: money(String(r.percentual_reserva)),
      baseCalculoReserva: String(r.base_calculo_reserva) as ConfigPixEfetiva['baseCalculoReserva'],
      diasRetencaoReserva: Number(r.dias_retencao_reserva),
      modoTratamentoMed: String(r.modo_tratamento_med) as ConfigPixEfetiva['modoTratamentoMed'],
      permiteSaldoNegativo: Boolean(r.permite_saldo_negativo),
      origemConfiguracao: String(r.origem_configuracao) as ConfigPixEfetiva['origemConfiguracao'],
    };
  }

  calcularSnapshotsEntrada(valorBruto: Decimal, cfg: ConfigPixEfetiva, custoPercentual: Decimal, custoFixo: Decimal) {
    const valorTarifa = calcTarifa(valorBruto, cfg.taxaPixEntradaPercentual, cfg.taxaPixEntradaFixa);
    const valorCusto = calcTarifa(valorBruto, custoPercentual, custoFixo);
    const valorLiquidacao = valorBruto.minus(valorTarifa);
    const baseReserva =
      cfg.baseCalculoReserva === 'VALOR_BRUTO' ? valorBruto : valorLiquidacao;
    const valorReserva = calcReserva(baseReserva, cfg.percentualReserva);
    const valorDisponivel = valorLiquidacao.minus(valorReserva);
    return {
      valorTarifa,
      valorCusto,
      valorLiquidacao,
      valorReserva,
      valorDisponivel,
      margem: valorTarifa.minus(valorCusto),
    };
  }
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Único ponto de escrita de saldo.
   * SELECT FOR UPDATE em saldos_empresas + movimentações + outbox no mesmo commit.
   */
  async aplicarMovimentacoes(params: {
    empresaId: bigint;
    entries: LedgerEntry[];
    outbox?: {
      tipoAgregado: string;
      identificadorAgregado: string;
      tipoEvento: string;
      conteudo: Prisma.InputJsonValue;
    };
    permiteSaldoNegativo?: boolean;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const saldos = await tx.$queryRaw<
        Array<{
          empresa_id: bigint;
          saldo_disponivel: Prisma.Decimal;
          saldo_pendente_liberacao: Prisma.Decimal;
          saldo_reservado: Prisma.Decimal;
          saldo_bloqueado_med: Prisma.Decimal;
        }>
      >`
        SELECT empresa_id, saldo_disponivel, saldo_pendente_liberacao,
               saldo_reservado, saldo_bloqueado_med
        FROM saldos_empresas
        WHERE empresa_id = ${params.empresaId}
        FOR UPDATE
      `;
      if (!saldos[0]) {
        throw new BadRequestException('Saldo da empresa não encontrado');
      }

      let disponivel = money(saldos[0].saldo_disponivel.toString());
      let pendente = money(saldos[0].saldo_pendente_liberacao.toString());
      let reservado = money(saldos[0].saldo_reservado.toString());
      let bloqueado = money(saldos[0].saldo_bloqueado_med.toString());

      const created = [];

      for (const entry of params.entries) {
        const existing = await tx.movimentacaoSaldo.findUnique({
          where: { chaveIdempotencia: entry.chaveIdempotencia },
        });
        if (existing) {
          created.push(existing);
          continue;
        }

        const delta =
          entry.tipoMovimento === 'CREDITO' ? entry.valor : entry.valor.neg();

        let saldoApos: Decimal;
        switch (entry.tipoSaldo) {
          case 'DISPONIVEL':
            disponivel = disponivel.plus(delta);
            saldoApos = disponivel;
            break;
          case 'PENDENTE_LIBERACAO':
            pendente = pendente.plus(delta);
            saldoApos = pendente;
            break;
          case 'RESERVADO':
            reservado = reservado.plus(delta);
            saldoApos = reservado;
            break;
          case 'BLOQUEADO_MED':
            bloqueado = bloqueado.plus(delta);
            saldoApos = bloqueado;
            break;
        }

        if (!params.permiteSaldoNegativo && disponivel.isNegative()) {
          throw new BadRequestException('Saldo disponível insuficiente');
        }
        if (pendente.isNegative() || reservado.isNegative() || bloqueado.isNegative()) {
          throw new BadRequestException('Saldo interno inconsistente');
        }

        const mov = await tx.movimentacaoSaldo.create({
          data: {
            empresaId: params.empresaId,
            transacaoId: entry.transacaoId,
            casoMedId: entry.casoMedId,
            devolucaoPixId: entry.devolucaoPixId,
            chaveIdempotencia: entry.chaveIdempotencia,
            tipoSaldo: entry.tipoSaldo,
            tipoMovimento: entry.tipoMovimento,
            natureza: entry.natureza,
            valor: entry.valor.toFixed(2),
            saldoApos: saldoApos.toFixed(2),
            descricao: entry.descricao,
          },
        });
        created.push(mov);
      }

      await tx.saldoEmpresa.update({
        where: { empresaId: params.empresaId },
        data: {
          saldoDisponivel: disponivel.toFixed(2),
          saldoPendenteLiberacao: pendente.toFixed(2),
          saldoReservado: reservado.toFixed(2),
          saldoBloqueadoMed: bloqueado.toFixed(2),
        },
      });

      let outboxId: bigint | undefined;
      if (params.outbox) {
        const outbox = await tx.eventoOutbox.create({
          data: {
            empresaId: params.empresaId,
            tipoAgregado: params.outbox.tipoAgregado,
            identificadorAgregado: params.outbox.identificadorAgregado,
            tipoEvento: params.outbox.tipoEvento,
            conteudo: params.outbox.conteudo,
          },
        });
        outboxId = outbox.id;
      }

      return {
        movimentacoes: created,
        saldos: {
          disponivel: disponivel.toFixed(2),
          pendente: pendente.toFixed(2),
          reservado: reservado.toFixed(2),
          bloqueado: bloqueado.toFixed(2),
        },
        outboxId,
      };
    });
  }
}
