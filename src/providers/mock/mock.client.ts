import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ipAllowed, mensagemIpNaoPermitido } from '../ip-allowlist.util';
import {
  money,
  SITUACAO_EXECUCAO_SAQUE,
  SITUACAO_TRANSACAO,
} from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCashOutInput,
  CreateCashOutResult,
  CreateChargeInput,
  CreateChargeResult,
  CreateRefundInput,
  CreateRefundResult,
  GetBalanceResult,
  GetStatusResult,
  PaymentProviderPort,
  VerifyTransportInput,
} from '../payment-provider.port';

/** Estado em memória do mock para E2E local */
const mockCharges = new Map<
  string,
  { status: GetStatusResult['status']; valor: string; paid?: boolean }
>();

@Injectable()
export class MockPaymentProvider implements PaymentProviderPort {
  readonly code = 'mock';

  constructor(private readonly prisma: PrismaService) {}

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const id = `mock_${input.idTransacaoPrivado}`;
    mockCharges.set(id, {
      status: 'WAITING_PAYMENT',
      valor: input.valor.toFixed(2),
    });
    const txid = `MOCK${Date.now()}`.slice(0, 35);
    return {
      idTransacaoLiquidante: id,
      txid,
      pixCopiaCola: `00020126580014br.gov.bcb.pix0136${input.idTransacaoPublico}520400005303986540${input.valor.toFixed(2)}5802BR5913VPAY MOCK6009SAO PAULO62070503***6304ABCD`,
      urlCheckout: `https://mock.vpay.local/checkout/${input.idTransacaoPublico}`,
      expiraEm: new Date(Date.now() + (input.expiracaoSegundos ?? 3600) * 1000),
      raw: { mock: true, id },
    };
  }

  async createCashOut(input: CreateCashOutInput): Promise<CreateCashOutResult> {
    const id = `mock_out_${input.idTransacaoPrivado}`;
    mockCharges.set(id, { status: 'COMPLETED', valor: input.valor.toFixed(2), paid: true });
    return { idTransacaoLiquidante: id, raw: { mock: true, id } };
  }

  async getStatus(params: {
    idTransacaoLiquidante?: string;
    idTransacaoPrivado: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetStatusResult> {
    const id =
      params.idTransacaoLiquidante ?? `mock_${params.idTransacaoPrivado}`;

    // Fast path: mesmo processo (testes locais na API).
    const entry = mockCharges.get(id);
    if (entry?.paid) {
      return {
        status: entry.status,
        valor: money(entry.valor),
        endToEndId: `E2E${id}`,
        paidAt: new Date(),
        raw: entry,
      };
    }

    // API e Worker são processos separados — memória não é compartilhada.
    // A "liquidante mock" considera pago quando existe webhook PAID persistido
    // no banco para este id (fonte de verdade compartilhada), simulando a
    // consulta de status na adquirente real (Camada 1).
    const webhookPago = await this.prisma.webhookRecebidoProvedor.findFirst({
      where: {
        provedor: { codigo: this.code },
        conteudo: { path: ['transactionId'], equals: id },
      },
      orderBy: { id: 'desc' },
    });
    const conteudo = webhookPago?.conteudo as Record<string, unknown> | undefined;
    if (conteudo && String(conteudo.status ?? '').toUpperCase() === 'PAID') {
      const valorWh = conteudo.amount ?? conteudo.valor;
      return {
        status: 'PAID',
        valor: valorWh !== undefined ? money(String(valorWh)) : entry ? money(entry.valor) : undefined,
        endToEndId: `E2E${id}`,
        paidAt: webhookPago?.recebidoEm ?? new Date(),
        raw: { fonte: 'webhook_persistido', id, ...conteudo },
      };
    }

    if (entry) {
      return { status: entry.status, valor: money(entry.valor), raw: entry };
    }
    return { status: 'PENDING', raw: { found: false } };
  }

  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    // A liquidante mock aceita a devolução na hora. O identificador devolvido
    // é determinístico para manter a operação idempotente em retentativas.
    const id = `mock_ref_${input.idDevolucaoPublico}`;
    const entry = mockCharges.get(input.idTransacaoLiquidante);
    if (entry) entry.status = 'REFUNDED';
    return { identificadorDevolucaoProvedor: id, raw: { mock: true, id } };
  }

  /**
   * Saldo da nossa conta na "adquirente mock". A adquirente real responde isso
   * numa chamada de API; aqui o número é DERIVADO do próprio banco para que a
   * tela e os gatilhos vejam valores coerentes com o movimento real:
   *
   *   disponível = cash-in liquidado − custo da adquirente − cash-out enviado
   *                − saques de tesouraria já efetivados
   *   bloqueado  = valor ainda bloqueado em casos MED da conta
   */
  async getBalance(params: {
    contaProvedorId: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetBalanceResult> {
    const contaProvedorId = BigInt(params.contaProvedorId);

    const [entradas, saidas, tesouraria, medBloqueado] = await Promise.all([
      this.prisma.transacao.aggregate({
        where: {
          contaProvedorId,
          direcao: 'ENTRADA',
          situacao: {
            in: [SITUACAO_TRANSACAO.LIQUIDADA, SITUACAO_TRANSACAO.CONCLUIDA],
          },
        },
        _sum: { valorBruto: true, valorCustoPixProvedor: true },
      }),
      this.prisma.transacao.aggregate({
        where: {
          contaProvedorId,
          direcao: 'SAIDA',
          situacao: {
            in: [
              SITUACAO_TRANSACAO.PROCESSANDO,
              SITUACAO_TRANSACAO.LIQUIDADA,
              SITUACAO_TRANSACAO.CONCLUIDA,
            ],
          },
        },
        _sum: { valorBruto: true, valorCustoPixProvedor: true },
      }),
      this.prisma.execucaoGatilhoSaque.aggregate({
        where: {
          contaProvedorId,
          situacao: {
            in: [SITUACAO_EXECUCAO_SAQUE.ENVIADA, SITUACAO_EXECUCAO_SAQUE.CONCLUIDA],
          },
        },
        _sum: { valorSolicitado: true },
      }),
      this.prisma.casoMed.aggregate({
        where: { transacao: { contaProvedorId } },
        _sum: { valorBloqueado: true },
      }),
    ]);

    const dec = (v: unknown) => money(String(v ?? '0'));
    const disponivel = dec(entradas._sum.valorBruto)
      .minus(dec(entradas._sum.valorCustoPixProvedor))
      .minus(dec(saidas._sum.valorBruto))
      .minus(dec(saidas._sum.valorCustoPixProvedor))
      .minus(dec(tesouraria._sum.valorSolicitado))
      .toDecimalPlaces(2);

    return {
      // A adquirente nunca devolve saldo negativo — ela zera. Espelhar isso
      // evita que o CHECK de saldos_adquirentes derrube o tick por causa de
      // arredondamento ou de uma conta recém-criada sem movimento.
      disponivel: disponivel.lt(0) ? money('0') : disponivel,
      bloqueado: dec(medBloqueado._sum.valorBloqueado).toDecimalPlaces(2),
      moeda: 'BRL',
      raw: { mock: true, contaProvedorId: params.contaProvedorId },
    };
  }

  /** Marca cobrança como paga (usado por webhook mock / testes) */
  markPaid(idTransacaoLiquidante: string) {
    const entry = mockCharges.get(idTransacaoLiquidante);
    if (entry) {
      entry.status = 'PAID';
      entry.paid = true;
    } else {
      mockCharges.set(idTransacaoLiquidante, {
        status: 'PAID',
        valor: '0',
        paid: true,
      });
    }
  }

  async verifyTransport(input: VerifyTransportInput): Promise<boolean> {
    if (!ipAllowed(input.ip, input.allowedIps)) {
      throw new UnauthorizedException(mensagemIpNaoPermitido(input.ip));
    }
    if (input.exigeAssinatura) {
      const key = (input.headers['x-key'] || input.headers['x-api-key']) as
        | string
        | undefined;
      if (!key) throw new UnauthorizedException('x-key ausente');
      if (input.segredoWebhookHash) {
        const ok = await argon2.verify(input.segredoWebhookHash, key);
        if (!ok) throw new UnauthorizedException('x-key inválida');
      } else if (input.webhookKeyEnv && key !== input.webhookKeyEnv) {
        throw new UnauthorizedException('x-key inválida');
      }
    }
    return true;
  }
}

export function parseMockValor(v: unknown): string {
  return money(String(v ?? '0')).toFixed(2);
}
