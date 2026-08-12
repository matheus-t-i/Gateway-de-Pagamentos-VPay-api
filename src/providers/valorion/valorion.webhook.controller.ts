import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Logger,
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
import {
  ROTAS_WEBHOOK_VALORION,
  codigoValorionDaRota,
  type CodigoValorion,
} from './valorion.codigos';
import { decryptCredentials } from '../../common/crypto.util';
import { extrairValorDePayload } from '../valor-remoto.util';
import { rotaSemPrefixo } from '../../common/api-prefix';
import { ProviderRegistry } from '../provider.registry';

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

/**
 * Eco da referência que mandamos no create — recovery quando o id liquidante
 * ainda não estava gravado na tentativa (crash pós-aceite).
 *
 * O nome REAL no postback da Valorion é `externalreference` (tudo minúsculo,
 * sem separador — é o mesmo campo que o refund lê do corpo armazenado em
 * `valorion.client.ts`). Os outros nomes ficam como tolerância a variação de
 * ambiente; o eco aninhado cobre o caso de devolverem o objeto `customer` que
 * enviamos no create (`customer.externaRef`).
 */
function extrairExternaRef(body: Record<string, unknown>): unknown {
  const customer = body.customer as Record<string, unknown> | undefined;
  return (
    body.externalreference ??
    body.externaRef ??
    body.externalRef ??
    body.externa_ref ??
    body.external_reference ??
    customer?.externaRef ??
    customer?.externalreference ??
    undefined
  );
}
@Controller(ROTAS_WEBHOOK_VALORION)
@Throttle({ limit: 6000, windowSec: 60 })
export class ValorionWebhookController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly providers: ProviderRegistry,
    private readonly config: ConfigService,
    private readonly med: MedService,
  ) {}

  @Post('pix-in')
  async pixIn(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Query('token') token: string | undefined,
    @Req() req: { ip?: string; path?: string; url?: string },
  ) {
    return this.handle(
      body,
      headers,
      token,
      req.ip ?? '127.0.0.1',
      'cashin',
      this.codigoDaReq(req),
    );
  }

  @Post('pix-out')
  async pixOut(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Query('token') token: string | undefined,
    @Req() req: { ip?: string; path?: string; url?: string },
  ) {
    return this.handle(
      body,
      headers,
      token,
      req.ip ?? '127.0.0.1',
      'cashout',
      this.codigoDaReq(req),
    );
  }

  private codigoDaReq(req: { path?: string; url?: string }): CodigoValorion {
    const codigo = codigoValorionDaRota(rotaSemPrefixo(req));
    if (!codigo) {
      throw new BadRequestException('Rota Valorion desconhecida');
    }
    return codigo;
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
  private readonly logger = new Logger(ValorionWebhookController.name);

  /**
   * MED de cash-in: Camada 1 + registro do caso, com a regra do webhook
   * ("responder 200 mesmo ao descartar") aplicada de verdade.
   *
   * Erro de NEGÓCIO aqui é determinístico — teto da venda estourado, `amount`
   * ausente, transação desconhecida, Camada 1 não confirmando: responder 4xx
   * fazia a Valorion retentar PARA SEMPRE o mesmo aviso, tomando o mesmo 400 a
   * cada entrega. Pior que o ruído: a adquirente JÁ tirou o dinheiro da nossa
   * conta, e o aviso rejeitado significava lojista nunca debitado — rombo
   * permanente e silencioso da VPay. Agora o descarte devolve 200 com o motivo
   * gravado em `mensagemErro`, e a linha fica fora de PROCESSADO para o
   * suporte reprocessar. Erro TRANSITÓRIO (rede/timeout na consulta) continua
   * estourando 500 — a reentrega da liquidante é a retentativa correta.
   *
   * 400 continua existindo só para transporte inválido (payload sem
   * `idtransaction`), como manda a regra.
   */
  private async processarMedCashin(
    body: Record<string, unknown>,
    liquidanteId: string,
    chave: string,
    webhookId: bigint,
    codigo: CodigoValorion,
  ): Promise<{ casoMed?: unknown; descartado?: string }> {
    if (!liquidanteId) {
      throw new BadRequestException('Payload MED sem idtransaction.');
    }
    try {
      const tentativa = await this.prisma.tentativaTransacao.findFirst({
        where: {
          idTransacaoLiquidante: liquidanteId,
          transacao: { contaProvedor: { provedor: { codigo } } },
        },
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
      // `String(body.amount ?? '0')` virava valor `0` (400 eterno) quando o
      // campo faltava — o resto do código já usa o extrator tolerante.
      const valor = extrairValorDePayload(body);
      if (!valor || valor.lte(0)) {
        throw new BadRequestException('Payload MED sem valor utilizável.');
      }
      await this.confirmarMedNaLiquidante({
        codigo,
        liquidanteId,
        idTransacaoPrivado: tentativa.transacao.idTransacaoPrivado,
        credenciaisCriptografadas:
          tentativa.transacao.contaProvedor.credenciaisCriptografadas,
      });
      const caso = await this.med.receber({
        idTransacaoPublico: tentativa.transacao.idTransacaoPublico,
        valorSolicitado: valor.toFixed(2),
        identificadorMedProvedor: String(body.endToEnd ?? '') || chave,
        motivo: 'MED informado pela Valorion',
        webhookRecebidoId: webhookId,
        origem: 'WEBHOOK_PROVEDOR',
      });
      await this.prisma.webhookRecebidoProvedor.update({
        where: { id: webhookId },
        data: {
          situacao: SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO,
          processadoEm: new Date(),
          mensagemErro: null,
        },
      });
      return { casoMed: caso };
    } catch (e) {
      if (e instanceof BadRequestException) {
        const motivo = e.message;
        this.logger.error(
          `MED descartado (200) liquidante=${liquidanteId}: ${motivo} — ` +
            `webhook=${webhookId} segue fora de PROCESSADO para conferência`,
        );
        await this.prisma.webhookRecebidoProvedor.update({
          where: { id: webhookId },
          data: { mensagemErro: `MED descartado: ${motivo}`.slice(0, 1000) },
        });
        return { descartado: motivo };
      }
      throw e;
    }
  }

  private async confirmarMedNaLiquidante(params: {
    codigo: CodigoValorion;
    liquidanteId: string;
    idTransacaoPrivado: string;
    credenciaisCriptografadas: string;
  }) {
    const credenciais = decryptCredentials(params.credenciaisCriptografadas);
    const remote = await this.providers.get(params.codigo).getStatus({
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
    codigo: CodigoValorion,
  ) {
    this.conferirToken(token);

    const provedor = await this.prisma.provedorPagamento.findUnique({
      where: { codigo },
      include: { ipsWebhook: true },
    });
    if (!provedor) {
      throw new UnauthorizedException(`Provedor ${codigo} ausente`);
    }

    // Camada 2 — IP daquela adquirente; token é o mesmo nas cinco.
    await this.providers.get(codigo).verifyTransport({
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

    const chave = `${codigo}:${eventId}`;
    const existing = await this.prisma.webhookRecebidoProvedor.findUnique({
      where: { chaveIdempotencia: chave },
    });
    if (existing) {
      // Persistiu mas o enqueue/processamento pode ter falhado — reentrega da
      // liquidante não pode virar no-op silencioso com o dinheiro ainda sem crédito.
      if (existing.situacao !== SITUACAO_WEBHOOK_RECEBIDO.PROCESSADO) {
        if (kind === 'cashin' && statusOriginal === 'MED') {
          const r = await this.processarMedCashin(
            body,
            liquidanteId,
            chave,
            existing.id,
            codigo,
          );
          return {
            ok: true,
            duplicated: true,
            id: existing.id.toString(),
            ...r,
          };
        }
        await this.reenfileirarWebhook(
          kind,
          existing.id,
          body,
          liquidanteId,
          statusOriginal,
          codigo,
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
      const r = await this.processarMedCashin(
        body,
        liquidanteId,
        chave,
        webhook.id,
        codigo,
      );
      return { ok: true, id: webhook.id.toString(), ...r };
    }

    // Tradução para o contrato genérico das filas.
    const payload = {
      ...body,
      transactionId: liquidanteId,
      status: ValorionPaymentProvider.mapStatus(
        statusOriginal,
        kind === 'cashout' ? 'CASH OUT' : 'CASH IN',
      ),
      externaRef: extrairExternaRef(body),
    };

    if (kind === 'cashin') {
      await this.queues.enqueuePixWebhookReceived({
        provider: codigo,
        payload,
        webhookRecebidoId: webhook.id.toString(),
        identificadorRastreio: rastreio,
      });
    } else {
      await this.queues.enqueuePixWebhookCashout({
        provider: codigo,
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
    codigo: CodigoValorion,
  ) {
    const payload = {
      ...body,
      transactionId: liquidanteId,
      status: ValorionPaymentProvider.mapStatus(
        statusOriginal,
        kind === 'cashout' ? 'CASH OUT' : 'CASH IN',
      ),
      externaRef: extrairExternaRef(body),
    };
    const rastreio = getRastreio();
    if (kind === 'cashin') {
      await this.queues.enqueuePixWebhookReceived({
        provider: codigo,
        payload,
        webhookRecebidoId: webhookId.toString(),
        identificadorRastreio: rastreio,
      });
    } else {
      await this.queues.enqueuePixWebhookCashout({
        provider: codigo,
        payload,
        webhookRecebidoId: webhookId.toString(),
        identificadorRastreio: rastreio,
      });
    }
  }
}
