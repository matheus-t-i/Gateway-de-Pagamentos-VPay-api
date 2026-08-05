import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { SITUACAO_WEBHOOK_RECEBIDO } from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import { QueuesService } from '../../queues/queues.service';
import { getRastreio } from '../../common/request-context';
import { MockPaymentProvider } from './mock.client';
import { MedService } from '../../med/med.service';
import { Throttle } from '../../common/ip-throttle.guard';

/**
 * Webhook da adquirente. O teto global de 300 req/min por IP é pensado para
 * navegador humano e é BAIXO demais aqui: a liquidante entrega de um punhado de
 * IPs e em rajada (retentativa de fila acumulada), então o limite padrão
 * recusaria confirmação de pagamento legítima — 429 aqui é dinheiro que entrou
 * e não foi creditado.
 *
 * Afrouxar não abre buraco: o acesso já passa por allowlist de IP + `x-key`
 * (camada 2) e a consulta de status na liquidante (camada 1).
 */
@Controller('webhooks/mock')
@Throttle({ limit: 6000, windowSec: 60 })
export class MockWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly mock: MockPaymentProvider,
    private readonly config: ConfigService,
    private readonly med: MedService,
  ) {}

  @Post('pix-in')
  async pixIn(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Req() req: { ip?: string },
  ) {
    return this.handle(body, headers, req.ip ?? '127.0.0.1', 'cashin');
  }

  @Post('pix-out')
  async pixOut(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Req() req: { ip?: string },
  ) {
    return this.handle(body, headers, req.ip ?? '127.0.0.1', 'cashout');
  }

  /**
   * Contestação (MED) vinda da adquirente. Passa pelas mesmas Camadas 1/2 e
   * é registrada de forma idempotente antes de mexer em qualquer saldo.
   */
  @Post('med')
  async medWebhook(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Req() req: { ip?: string },
  ) {
    return this.handle(body, headers, req.ip ?? '127.0.0.1', 'med');
  }

  private async handle(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    ip: string,
    kind: 'cashin' | 'cashout' | 'med',
  ) {
    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo: 'mock' },
      include: { ipsWebhook: true },
    });
    if (!provedor) throw new UnauthorizedException('Provedor mock ausente');

    // Camada 2
    await this.mock.verifyTransport({
      ip: ip.replace('::ffff:', ''),
      headers,
      body,
      allowedIps: provedor.ipsWebhook.map((i) => i.ipOuCidr),
      exigeAssinatura: provedor.exigeAssinaturaWebhook,
      segredoWebhookHash: provedor.segredoWebhookHash,
      webhookKeyEnv: this.config.get<string>('MOCK_PROVIDER_WEBHOOK_KEY'),
    });

    const eventId =
      String(body.eventId ?? body.id ?? '') ||
      createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const chave = `mock:${eventId}`;
    const existing = await this.prisma.webhookRecebidoProvedor.findUnique({
      where: { chaveIdempotencia: chave },
    });
    if (existing) {
      return { ok: true, duplicated: true, id: existing.id.toString() };
    }

    const webhook = await this.prisma.webhookRecebidoProvedor.create({
      data: {
        provedorPagamentoId: provedor.id,
        identificadorEventoExterno: eventId,
        chaveIdempotencia: chave,
        tipoEvento: String(body.type ?? kind),
        assinatura: headers['x-key'],
        conteudo: body as object,
        situacao: SITUACAO_WEBHOOK_RECEBIDO.RECEBIDO,
      },
    });

    const liquidanteId = String(body.transactionId ?? body.idTransacaoLiquidante ?? '');
    if (liquidanteId && body.status === 'PAID') {
      this.mock.markPaid(liquidanteId);
    }

    const rastreio = getRastreio();
    if (kind === 'med') {
      // MED altera saldo: resolvido na hora, com a transação local localizada
      // pelo id público informado pela adquirente.
      const idTransacaoPublico = String(
        body.idTransacao ?? body.transacaoIdPublico ?? '',
      );
      if (!idTransacaoPublico) {
        throw new BadRequestException('Payload MED sem idTransacao.');
      }
      const caso = await this.med.receber({
        idTransacaoPublico,
        valorSolicitado: String(body.valor ?? body.amount ?? '0'),
        identificadorMedProvedor: String(
          body.medId ?? body.eventId ?? webhook.chaveIdempotencia,
        ),
        motivo: body.motivo ? String(body.motivo) : undefined,
        webhookRecebidoId: webhook.id,
        origem: 'WEBHOOK_PROVEDOR',
      });
      await this.prisma.webhookRecebidoProvedor.update({
        where: { id: webhook.id },
        data: {
          situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
          processadoEm: new Date(),
        },
      });
      return { ok: true, id: webhook.id.toString(), casoMed: caso };
    }

    if (kind === 'cashin') {
      await this.queues.enqueuePixWebhookReceived({
        provider: 'mock',
        payload: body,
        webhookRecebidoId: webhook.id.toString(),
        identificadorRastreio: rastreio,
      });
    } else {
      await this.queues.enqueuePixWebhookCashout({
        provider: 'mock',
        payload: body,
        webhookRecebidoId: webhook.id.toString(),
        identificadorRastreio: rastreio,
      });
    }

    return { ok: true, id: webhook.id.toString() };
  }
}
