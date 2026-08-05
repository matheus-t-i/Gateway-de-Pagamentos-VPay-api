import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { SITUACAO_WEBHOOK_RECEBIDO } from '../../shared';
import { PrismaService } from '../../prisma/prisma.service';
import { QueuesService } from '../../queues/queues.service';
import { getRastreio } from '../../common/request-context';
import { MedService } from '../../med/med.service';
import { Throttle } from '../../common/ip-throttle.guard';
import { ValorionPaymentProvider } from './valorion.client';

/**
 * Postback da Valorion. Mesmo racional do controller mock: o teto global de
 * 300 req/min por IP é para navegador humano; a liquidante entrega em rajada
 * de poucos IPs e um 429 aqui é pagamento confirmado que não foi creditado.
 *
 * A Valorion NÃO assina o postback. As defesas são: token secreto na query do
 * postbackUrl (`?token=`, VALORION_WEBHOOK_TOKEN), allowlist de IP cadastrada
 * no admin (Camada 2) e a consulta de status na liquidante feita pelo
 * processor antes de creditar (Camada 1).
 *
 * O payload deles usa `idtransaction`/`PAID_OUT`; os processors genéricos
 * esperam `transactionId`/`PAID` — a tradução acontece AQUI, no controller por
 * adquirente, para as filas continuarem genéricas.
 */
@Controller('webhooks/valorion')
@Throttle({ limit: 6000, windowSec: 60 })
export class ValorionWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly valorion: ValorionPaymentProvider,
    private readonly config: ConfigService,
    private readonly med: MedService,
  ) {}

  @Post('pix-in')
  async pixIn(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Query('token') token: string | undefined,
    @Req() req: { ip?: string },
  ) {
    return this.handle(body, headers, token, req.ip ?? '127.0.0.1', 'cashin');
  }

  @Post('pix-out')
  async pixOut(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Query('token') token: string | undefined,
    @Req() req: { ip?: string },
  ) {
    return this.handle(body, headers, token, req.ip ?? '127.0.0.1', 'cashout');
  }

  private conferirToken(token: string | undefined) {
    const esperado = this.config.get<string>('VALORION_WEBHOOK_TOKEN');
    if (!esperado || esperado.trim() === '') return; // token desabilitado
    const a = Buffer.from(token ?? '', 'utf8');
    const b = Buffer.from(esperado.trim(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Token de postback inválido');
    }
  }

  private async handle(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    token: string | undefined,
    ip: string,
    kind: 'cashin' | 'cashout',
  ) {
    this.conferirToken(token);

    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo: 'valorion' },
      include: { ipsWebhook: true },
    });
    if (!provedor) throw new UnauthorizedException('Provedor valorion ausente');

    // Camada 2
    await this.valorion.verifyTransport({
      ip: ip.replace('::ffff:', ''),
      headers,
      body,
      allowedIps: provedor.ipsWebhook.map((i) => i.ipOuCidr),
      exigeAssinatura: provedor.exigeAssinaturaWebhook,
      segredoWebhookHash: provedor.segredoWebhookHash,
    });

    const liquidanteId = String(body.idtransaction ?? body.idTransaction ?? '');
    const statusOriginal = String(body.status ?? '').toUpperCase();

    // O MED chega com o MESMO `id` do evento de pagamento — só o status muda.
    // O status entra na chave para o MED não morrer como duplicata do PAID_OUT.
    const eventId =
      [String(body.id ?? ''), liquidanteId, statusOriginal]
        .filter(Boolean)
        .join(':') ||
      createHash('sha256').update(JSON.stringify(body)).digest('hex');

    const chave = `valorion:${eventId}`;
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
        tipoEvento: statusOriginal || kind,
        conteudo: body as object,
        situacao: SITUACAO_WEBHOOK_RECEBIDO.RECEBIDO,
      },
    });

    const rastreio = getRastreio();

    // Contestação: a Valorion avisa MED pelo mesmo postback de cash-in.
    if (kind === 'cashin' && statusOriginal === 'MED') {
      if (!liquidanteId) {
        throw new BadRequestException('Payload MED sem idtransaction.');
      }
      const tentativa = await this.prisma.tentativaTransacao.findFirst({
        where: { idTransacaoLiquidante: liquidanteId },
        include: { transacao: true },
        orderBy: { criadoEm: 'desc' },
      });
      if (!tentativa) {
        throw new BadRequestException(
          `MED para transação desconhecida: ${liquidanteId}`,
        );
      }
      const caso = await this.med.receber({
        idTransacaoPublico: tentativa.transacao.idTransacaoPublico,
        valorSolicitado: String(body.amount ?? '0'),
        identificadorMedProvedor: String(body.endToEnd ?? '') || chave,
        motivo: 'MED informado pela Valorion',
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

    // Tradução para o contrato genérico das filas.
    const payload = {
      ...body,
      transactionId: liquidanteId,
      status: ValorionPaymentProvider.mapStatus(
        statusOriginal,
        kind === 'cashout' ? 'CASH OUT' : 'CASH IN',
      ),
    };

    if (kind === 'cashin') {
      await this.queues.enqueuePixWebhookReceived({
        provider: 'valorion',
        payload,
        webhookRecebidoId: webhook.id.toString(),
        identificadorRastreio: rastreio,
      });
    } else {
      await this.queues.enqueuePixWebhookCashout({
        provider: 'valorion',
        payload,
        webhookRecebidoId: webhook.id.toString(),
        identificadorRastreio: rastreio,
      });
    }

    return { ok: true, id: webhook.id.toString() };
  }
}
