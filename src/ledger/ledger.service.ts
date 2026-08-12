import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  calcReserva,
  calcTarifa,
  MODO_TRATAMENTO_MED,
  money,
} from '../shared';
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
  /** Teto diário de saque (BRT). null = sem teto. */
  limiteDiarioPixSaida: Decimal | null;
  /** Máximo de saques por hora. null = sem teto. */
  maxSaquesPorHora: number | null;
  permitirPixSaidaViaApi: boolean;
  /** Por onde o saque pode ser pedido (painel, API ou os dois). */
  origemSaquePermitida: 'PAINEL' | 'API' | 'AMBOS';
  /**
   * true = API também exige chave cadastrada/APROVADA.
   * false = API (BAAS) aceita chave livre, com IP allowlist na credencial.
   * Painel sempre exige cadastrada — esta flag não libera chave livre no painel.
   */
  exigirChavePixCadastrada: boolean;
  diasLiberacaoSaldo: number;
  percentualReserva: Decimal;
  baseCalculoReserva: 'VALOR_BRUTO' | 'VALOR_LIQUIDO_EMPRESA';
  diasRetencaoReserva: number;
  modoTratamentoMed: 'BLOQUEAR_SALDO' | 'DEBITAR_IMEDIATAMENTE';
  permiteSaldoNegativo: boolean;
};

type LedgerEntry = {
  tipoSaldo:
    | 'DISPONIVEL'
    | 'PENDENTE_LIBERACAO'
    | 'RESERVADO'
    | 'BLOQUEADO_MED'
    | 'BLOQUEADO_MANUAL';
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
    | 'BLOQUEIO_MANUAL'
    | 'DESBLOQUEIO_MANUAL'
    | 'DEBITO_MANUAL'
    /** Devolução de saque que a liquidante recusou — nunca em desfecho ambíguo. */
    | 'ESTORNO_SAQUE'
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
      limiteDiarioPixSaida: cfg.limiteDiarioPixSaida
        ? money(cfg.limiteDiarioPixSaida.toString())
        : null,
      maxSaquesPorHora: cfg.maxSaquesPorHora,
      permitirPixSaidaViaApi: cfg.permitirPixSaidaViaApi,
      origemSaquePermitida: cfg.origemSaquePermitida,
      exigirChavePixCadastrada: cfg.exigirChavePixCadastrada,
      diasLiberacaoSaldo: cfg.diasLiberacaoSaldo,
      percentualReserva: money(cfg.percentualReserva.toString()),
      baseCalculoReserva: cfg.baseCalculoReserva,
      diasRetencaoReserva: cfg.diasRetencaoReserva,
      modoTratamentoMed: cfg.modoTratamentoMed,
      /**
       * Débito direto de MED implica conta podendo ficar negativa: a adquirente
       * já levou o dinheiro, então o débito precisa sair mesmo sem saldo. A
       * coerção fica aqui — e não só na gravação — para valer também em linha
       * antiga, gravada antes da regra existir.
       *
       * Isto NÃO libera saque a descoberto: `criarSaque` debita com
       * `permiteSaldoNegativo: false` fixo, de propósito.
       */
      permiteSaldoNegativo:
        cfg.permiteSaldoNegativo ||
        cfg.modoTratamentoMed === MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE,
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
   * Abre a carteira zerada se ainda não existir. A ativação já faz isso; aqui
   * cobre conta antiga/admin/seed sem linha — um PIX pago não pode morrer em
   * "carteira não encontrada" depois da Camada 1 ter confirmado.
   */
  async garantirCarteira(
    usuarioId: bigint,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    await db.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId },
      update: {},
    });
  }

  /**
   * Único ponto de escrita de saldo.
   * SELECT FOR UPDATE em saldos_usuarios + movimentações + outbox no mesmo commit.
   *
   * `db` permite rodar DENTRO de uma transação de quem chama, em vez de abrir a
   * própria. É o que deixa o saque criar a transação e debitar no MESMO commit:
   * ou nascem as duas coisas, ou nenhuma — sem janela de movimentação órfã.
   */
  async aplicarMovimentacoes(
    params: {
      usuarioId: bigint;
      entries: LedgerEntry[];
      outbox?: {
        tipoAgregado: string;
        identificadorAgregado: string;
        tipoEvento: string;
        conteudo: Prisma.InputJsonValue;
      };
      permiteSaldoNegativo?: boolean;
    },
    db?: Prisma.TransactionClient,
  ) {
    const executar = async (tx: Prisma.TransactionClient) => {
      await this.garantirCarteira(params.usuarioId, tx);
      const saldos = await tx.$queryRaw<
        Array<{
          usuario_id: bigint;
          saldo_disponivel: Prisma.Decimal;
          saldo_pendente_liberacao: Prisma.Decimal;
          saldo_reservado: Prisma.Decimal;
          saldo_bloqueado_med: Prisma.Decimal;
          saldo_bloqueado_manual: Prisma.Decimal;
        }>
      >`
        SELECT usuario_id, saldo_disponivel, saldo_pendente_liberacao,
               saldo_reservado, saldo_bloqueado_med, saldo_bloqueado_manual
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
      let bloqueadoManual = money(saldos[0].saldo_bloqueado_manual.toString());

      const created = [];
      let novasMovimentacoes = 0;

      for (const entry of params.entries) {
        const existing = await tx.movimentacaoSaldo.findUnique({
          where: { chaveIdempotencia: entry.chaveIdempotencia },
        });
        if (existing) {
          /**
           * Dedupe idempotente EXIGE que a chave signifique a MESMA
           * movimentação. Sem esta conferência, uma chave reaproveitada com
           * outro valor devolveria a movimentação ANTIGA sem debitar o novo
           * valor — o débito real ficaria descasado do que a operação acha ter
           * debitado, e o dinheiro sumiria do lojista sem transação que o
           * explicasse.
           *
           * Hoje toda chave de dinheiro deriva de id NOSSO
           * (`saque:hold:<idTransacaoPrivado>`, `saque:estorno:<txId>`,
           * `cashin:*:<txId>`), então divergência aqui significa bug ou
           * corrupção — nunca fluxo normal. Falha fechada, para reconciliação
           * humana.
           */
          const mesmaMovimentacao =
            existing.tipoSaldo === entry.tipoSaldo &&
            existing.tipoMovimento === entry.tipoMovimento &&
            existing.natureza === entry.natureza &&
            money(existing.valor.toString()).eq(entry.valor);
          if (!mesmaMovimentacao) {
            throw new BadRequestException(
              `Chave de idempotência "${entry.chaveIdempotencia}" já usada com outro ` +
                'valor/tipo de movimentação. Operação recusada para reconciliação manual.',
            );
          }
          created.push(existing);
          continue;
        }

        novasMovimentacoes += 1;
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
          case 'BLOQUEADO_MANUAL':
            bloqueadoManual = bloqueadoManual.plus(delta);
            saldoApos = bloqueadoManual;
            break;
        }

        /**
         * A trava é sobre ESTA movimentação, não sobre o estado da conta: só
         * recusa DÉBITO do DISPONIVEL que deixe o saldo negativo.
         *
         * Antes ela olhava só `disponivel.isNegative()` depois de cada entry,
         * sem ver o que a entry fez — então, numa conta já negativa (o que
         * acontece sempre que um MED é debitado direto), QUALQUER movimentação
         * seguinte quebrava: a liberação D+/reserva (fila 6) morria em FALHA
         * terminal com o dinheiro preso em PENDENTE_LIBERACAO, o MED recusado
         * não devolvia o bloqueado e o bloqueio administrativo não liberava —
         * inclusive o crédito que quitaria a dívida, que é o único jeito de a
         * conta voltar ao positivo sozinha.
         */
        const debitaDisponivel =
          entry.tipoSaldo === 'DISPONIVEL' && entry.tipoMovimento === 'DEBITO';
        if (
          debitaDisponivel &&
          !params.permiteSaldoNegativo &&
          disponivel.isNegative()
        ) {
          throw new BadRequestException('Saldo disponível insuficiente');
        }
        if (
          pendente.isNegative() ||
          reservado.isNegative() ||
          bloqueado.isNegative() ||
          bloqueadoManual.isNegative()
        ) {
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
          saldoBloqueadoManual: bloqueadoManual.toFixed(2),
        },
      });

      let outboxId: bigint | undefined;
      // Outbox só quando houve crédito/débito NOVO — senão retry/concorrência
      // com chaves já existentes duplicava o callback ao lojista.
      if (params.outbox && novasMovimentacoes > 0) {
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
        novasMovimentacoes,
        saldos: {
          disponivel: disponivel.toFixed(2),
          pendente: pendente.toFixed(2),
          reservado: reservado.toFixed(2),
          bloqueado: bloqueado.toFixed(2),
        },
        outboxId,
      };
    };

    return db ? executar(db) : this.prisma.$transaction(executar);
  }
}
