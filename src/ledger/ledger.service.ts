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

  /**
   * Configuração efetiva do cliente. Com a conta sendo o próprio usuário não há
   * mais override por empresa — a linha de `configuracoes_pix_usuarios` É a
   * configuração, sem COALESCE.
   */
  async resolverEfetiva(usuarioId: bigint): Promise<ConfigPixEfetiva> {
    const cfg = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId },
    });
    if (!cfg) {
      throw new BadRequestException('Configuração PIX do cliente ausente');
    }
    return {
      contaProvedorPixEntradaId: cfg.contaProvedorPixEntradaId,
      contaProvedorPixSaidaId: cfg.contaProvedorPixSaidaId,
      taxaPixEntradaPercentual: money(cfg.taxaPixEntradaPercentual.toString()),
      taxaPixEntradaFixa: money(cfg.taxaPixEntradaFixa.toString()),
      taxaPixSaidaPercentual: money(cfg.taxaPixSaidaPercentual.toString()),
      taxaPixSaidaFixa: money(cfg.taxaPixSaidaFixa.toString()),
      ticketMinimoPixEntrada: money(cfg.ticketMinimoPixEntrada.toString()),
      ticketMaximoPixEntrada: money(cfg.ticketMaximoPixEntrada.toString()),
      ticketMinimoPixSaida: money(cfg.ticketMinimoPixSaida.toString()),
      ticketMaximoPixSaida: cfg.ticketMaximoPixSaida
        ? money(cfg.ticketMaximoPixSaida.toString())
        : null,
      permitirPixSaidaViaApi: cfg.permitirPixSaidaViaApi,
      diasLiberacaoSaldo: cfg.diasLiberacaoSaldo,
      percentualReserva: money(cfg.percentualReserva.toString()),
      baseCalculoReserva: cfg.baseCalculoReserva,
      diasRetencaoReserva: cfg.diasRetencaoReserva,
      modoTratamentoMed: cfg.modoTratamentoMed,
      permiteSaldoNegativo: cfg.permiteSaldoNegativo,
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
   * SELECT FOR UPDATE em saldos_usuarios + movimentações + outbox no mesmo commit.
   */
  async aplicarMovimentacoes(params: {
    usuarioId: bigint;
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
          usuario_id: bigint;
          saldo_disponivel: Prisma.Decimal;
          saldo_pendente_liberacao: Prisma.Decimal;
          saldo_reservado: Prisma.Decimal;
          saldo_bloqueado_med: Prisma.Decimal;
        }>
      >`
        SELECT usuario_id, saldo_disponivel, saldo_pendente_liberacao,
               saldo_reservado, saldo_bloqueado_med
        FROM saldos_usuarios
        WHERE usuario_id = ${params.usuarioId}
        FOR UPDATE
      `;
      if (!saldos[0]) {
        throw new BadRequestException('Carteira do cliente não encontrada');
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
            usuarioId: params.usuarioId,
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

      await tx.saldoUsuario.update({
        where: { usuarioId: params.usuarioId },
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
            usuarioId: params.usuarioId,
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
