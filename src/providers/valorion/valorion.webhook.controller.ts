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
import { decryptCredentials } from '../../common/crypto.util';

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
    // Em produção o boot exige o token; aqui fail-closed se sumir em runtime.
    if (!esperado || esperado.trim() === '') {
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'VALORION_WEBHOOK_TOKEN não configurado — Camada 2 obrigatória',
        );
      }
      return;
    }
    const a = Buffer.from(token ?? '', 'utf8');
    const b = Buffer.from(esperado.trim(), 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Token de postback inválido');
    }
  }

  /**
   * Camada 1 do MED: consulta a liquidante antes de mexer em saldo.
   * Sem isto, postback forjado com status=MED (e Camada 2 frouxa) debitava.
   */
  private async confirmarMedNaLiquidante(params: {
    liquidanteId: string;
    idTransacaoPrivado: string;
    credenciaisCriptografadas: string;
  }) {
    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(params.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(params.credenciaisCriptografadas);
    }
    const remote = await this.valorion.getStatus({
      idTransacaoLiquidante: params.liquidanteId,
      idTransacaoPrivado: params.idTransacaoPrivado,
      credenciais,
    });
    const rawStatus = String(
      (remote.raw as Record<string, unknown> | null)?.status ?? '',
    ).toUpperCase();
    const confirmado =
      remote.status === 'REFUNDED' ||
      /MED|CHARGEBACK|REFUND|DEVOLV/.test(rawStatus);
    if (!confirmado) {
      throw new BadRequestException(
        `Camada1 MED não confirmou na liquidante (status=${remote.status}).`,
      );
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
      // Persistiu mas o enqueue/processamento pode ter falhado — reentrega da
      // liquidante não pode virar no-op silencioso com o dinheiro ainda sem crédito.
      if (existing.situacao !== SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO) {
        if (kind === 'cashin' && statusOriginal === 'MED') {
          if (!liquidanteId) {
            throw new BadRequestException('Payload MED sem idtransaction.');
          }
          const tentativa = await this.prisma.tentativaTransacao.findFirst({
            where: { idTransacaoLiquidante: liquidanteId },
            include: {
              transacao: { include: { contaProvedor: true } },
            },
            orderBy: { criadoEm: 'desc' },
          });
          if (!tentativa) {
            throw new BadRequestException(
              `MED para transação desconhecida: ${liquidanteId}`,
            );
          }
          if (!tentativa.transacao.contaProvedor) {
            throw new BadRequestException('Transação MED sem conta de provedor');
          }
          await this.confirmarMedNaLiquidante({
            liquidanteId,
            idTransacaoPrivado: tentativa.transacao.idTransacaoPrivado,
            credenciaisCriptografadas:
              tentativa.transacao.contaProvedor.credenciaisCriptografadas,
          });
          const caso = await this.med.receber({
            idTransacaoPublico: tentativa.transacao.idTransacaoPublico,
            valorSolicitado: String(body.amount ?? '0'),
            identificadorMedProvedor: String(body.endToEnd ?? '') || chave,
            motivo: 'MED informado pela Valorion',
            webhookRecebidoId: existing.id,
            origem: 'WEBHOOK_PROVEDOR',
          });
          await this.prisma.webhookRecebidoProvedor.update({
            where: { id: existing.id },
            data: {
              situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
              processadoEm: new Date(),
            },
          });
          return {
            ok: true,
            duplicated: true,
            id: existing.id.toString(),
            casoMed: caso,
          };
        }
        await this.reenfileirarWebhook(
          kind,
          existing.id,
          body,
          liquidanteId,
          statusOriginal,
        );
      }
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
        include: {
          transacao: { include: { contaProvedor: true } },
        },
        orderBy: { criadoEm: 'desc' },
      });
      if (!tentativa) {
        throw new BadRequestException(
          `MED para transação desconhecida: ${liquidanteId}`,
        );
      }
      if (!tentativa.transacao.contaProvedor) {
        throw new BadRequestException('Transação MED sem conta de provedor');
      }
      await this.confirmarMedNaLiquidante({
        liquidanteId,
        idTransacaoPrivado: tentativa.transacao.idTransacaoPrivado,
        credenciaisCriptografadas:
          tentativa.transacao.contaProvedor.credenciaisCriptografadas,
      });
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
      // Eco da ref que mandamos no create — recovery se id liquidante ainda
      // não estava gravado na tentativa (crash pós-aceite).
      externaRef:
        body.externaRef ??
        body.externalRef ??
        body.externa_ref ??
        body.external_reference ??
        undefined,
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

  private async reenfileirarWebhook(
    kind: 'cashin' | 'cashout',
    webhookId: bigint,
    body: Record<string, unknown>,
    liquidanteId: string,
    statusOriginal: string,
  ) {
    const payload = {
      ...body,
      transactionId: liquidanteId,
      status: ValorionPaymentProvider.mapStatus(
        statusOriginal,
        kind === 'cashout' ? 'CASH OUT' : 'CASH IN',
      ),
      externaRef:
        body.externaRef ??
        body.externalRef ??
        body.externa_ref ??
        body.external_reference ??
        undefined,
    };
    const rastreio = getRastreio();
    if (kind === 'cashin') {
      await this.queues.enqueuePixWebhookReceived({
        provider: 'valorion',
        payload,
        webhookRecebidoId: webhookId.toString(),
        identificadorRastreio: rastreio,
      });
    } else {
      await this.queues.enqueuePixWebhookCashout({
        provider: 'valorion',
        payload,
        webhookRecebidoId: webhookId.toString(),
        identificadorRastreio: rastreio,
      });
    }
  }
}
