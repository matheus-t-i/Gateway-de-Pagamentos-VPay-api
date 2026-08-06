import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, money } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

export type DecisaoRetencao = {
  reter: boolean;
  motivo: string;
};

type InputDecisao = {
  valorBruto: Decimal;
  nomePagador?: string | null;
  emailPagador?: string | null;
  /** Conta da adquirente da venda (pode ser null). */
  percentualContaAdquirente?: Decimal | null;
  retencaoMetodoAtivoCliente: boolean;
  percentualRetencaoCliente: Decimal;
};

type EstadoRow = {
  id: number;
  ativo: boolean;
  texto_excecao: string;
  valor_minimo_retencao: string;
  faturamento_minimo_dia: string;
  offset_min: number;
  offset_max: number;
  percentual_fallback: string;
  offset_atual: number;
  data_referencia_dia: Date;
  faturamento_pago_dia: string;
  valor_retido_dia: string;
};

/** Dia civil em America/Sao_Paulo no formato YYYY-MM-DD. */
export function diaCivilSaoPaulo(agora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
}

function sortearOffset(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

@Injectable()
export class RetencaoMetodoService {
  private readonly logger = new Logger(RetencaoMetodoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decide se a venda paga deve ser retida. Atualiza offset/acumuladores
   * globais sob `SELECT … FOR UPDATE` no singleton.
   */
  async decidir(input: InputDecisao): Promise<DecisaoRetencao> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<EstadoRow[]>`
        SELECT
          id,
          ativo,
          texto_excecao,
          valor_minimo_retencao::text,
          faturamento_minimo_dia::text,
          offset_min,
          offset_max,
          percentual_fallback::text,
          offset_atual,
          data_referencia_dia,
          faturamento_pago_dia::text,
          valor_retido_dia::text
        FROM parametros_retencao_metodo
        WHERE id = 1
        FOR UPDATE
      `;

      let estado = rows[0];
      if (!estado) {
        await tx.parametroRetencaoMetodo.create({ data: { id: 1 } });
        const again = await tx.$queryRaw<EstadoRow[]>`
          SELECT
            id, ativo, texto_excecao,
            valor_minimo_retencao::text, faturamento_minimo_dia::text,
            offset_min, offset_max, percentual_fallback::text,
            offset_atual, data_referencia_dia,
            faturamento_pago_dia::text, valor_retido_dia::text
          FROM parametros_retencao_metodo
          WHERE id = 1
          FOR UPDATE
        `;
        estado = again[0];
      }

      const hoje = diaCivilSaoPaulo();
      const dataRef = estado.data_referencia_dia.toISOString().slice(0, 10);
      let offsetAtual = estado.offset_atual;
      let faturamentoPago = money(estado.faturamento_pago_dia);
      let valorRetido = money(estado.valor_retido_dia);

      if (dataRef !== hoje) {
        faturamentoPago = money(0);
        valorRetido = money(0);
      }

      if (!estado.ativo) {
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual,
          faturamentoPago: faturamentoPago.plus(input.valorBruto),
          valorRetido,
        });
        return { reter: false, motivo: 'metodo_inativo' };
      }

      const textoBruto = (estado.texto_excecao || '').trim().toLowerCase();
      if (textoBruto) {
        const termos = textoBruto
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        const nome = (input.nomePagador ?? '').toLowerCase();
        const email = (input.emailPagador ?? '').toLowerCase();
        if (termos.some((t) => nome.includes(t) || email.includes(t))) {
          await this.persistirEstado(tx, {
            hoje,
            offsetAtual,
            faturamentoPago: faturamentoPago.plus(input.valorBruto),
            valorRetido,
          });
          return { reter: false, motivo: 'excecao_texto' };
        }
      }

      const valorMin = money(estado.valor_minimo_retencao);
      if (input.valorBruto.lt(valorMin)) {
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual,
          faturamentoPago: faturamentoPago.plus(input.valorBruto),
          valorRetido,
        });
        return { reter: false, motivo: 'excecao_valor_minimo' };
      }

      const fatMin = money(estado.faturamento_minimo_dia);
      if (faturamentoPago.plus(input.valorBruto).lt(fatMin)) {
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual,
          faturamentoPago: faturamentoPago.plus(input.valorBruto),
          valorRetido,
        });
        return { reter: false, motivo: 'excecao_faturamento_minimo' };
      }

      if (
        input.retencaoMetodoAtivoCliente &&
        input.percentualRetencaoCliente.lte(0)
      ) {
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual,
          faturamentoPago: faturamentoPago.plus(input.valorBruto),
          valorRetido,
        });
        return { reter: false, motivo: 'cliente_percentual_zero' };
      }

      if (offsetAtual > 0) {
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual: offsetAtual - 1,
          faturamentoPago: faturamentoPago.plus(input.valorBruto),
          valorRetido,
        });
        return { reter: false, motivo: 'offset' };
      }

      const percLimite = input.retencaoMetodoAtivoCliente
        ? input.percentualRetencaoCliente
        : input.percentualContaAdquirente != null
          ? input.percentualContaAdquirente
          : money(estado.percentual_fallback);

      const fatApos = faturamentoPago.plus(input.valorBruto);
      const percAtual =
        faturamentoPago.gt(0)
          ? valorRetido.mul(100).div(faturamentoPago)
          : money(0);

      if (percAtual.gte(percLimite)) {
        const novoOffset = sortearOffset(estado.offset_min, estado.offset_max);
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual: novoOffset,
          faturamentoPago: fatApos,
          valorRetido,
        });
        this.logger.log(
          `retencao libera (bateu %): perc=${percAtual.toFixed(4)} limite=${percLimite.toFixed(4)} offset=${novoOffset}`,
        );
        return { reter: false, motivo: 'bateu_percentual_dia' };
      }

      const percSeReter = valorRetido.plus(input.valorBruto).mul(100).div(fatApos);
      if (percSeReter.gt(percLimite)) {
        const novoOffset = sortearOffset(estado.offset_min, estado.offset_max);
        await this.persistirEstado(tx, {
          hoje,
          offsetAtual: novoOffset,
          faturamentoPago: fatApos,
          valorRetido: valorRetido.plus(input.valorBruto),
        });
        this.logger.log(
          `retencao RETEM: percSeReter=${percSeReter.toFixed(4)} limite=${percLimite.toFixed(4)} offset=${novoOffset}`,
        );
        return { reter: true, motivo: 'estoura_percentual' };
      }

      await this.persistirEstado(tx, {
        hoje,
        offsetAtual,
        faturamentoPago: fatApos,
        valorRetido,
      });
      return { reter: false, motivo: 'cabe_sem_reter' };
    });
  }

  private async persistirEstado(
    tx: Prisma.TransactionClient,
    estado: {
      hoje: string;
      offsetAtual: number;
      faturamentoPago: Decimal;
      valorRetido: Decimal;
    },
  ) {
    await tx.$executeRaw`
      UPDATE parametros_retencao_metodo
      SET
        offset_atual = ${estado.offsetAtual},
        data_referencia_dia = ${estado.hoje}::date,
        faturamento_pago_dia = ${estado.faturamentoPago.toFixed(2)}::numeric,
        valor_retido_dia = ${estado.valorRetido.toFixed(2)}::numeric,
        atualizado_em = NOW()
      WHERE id = 1
    `;
  }
}
