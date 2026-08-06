import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STATUS_REMOTO_PEDIDO } from '../../shared';
import { EnvioApp, ErroEnvioIntegracao, PedidoVenda, ResultadoEnvio } from '../tipos';

/**
 * Utmify — rastreio de campanhas (https://docs.utmify.com.br).
 *
 * Integração de MÃO ÚNICA: a VPay empurra o pedido, a Utmify não nos chama.
 * Somos "a plataforma" (`platform`) no vocabulário deles, e a credencial é do
 * LOJISTA (ele gera em Integrações → Webhooks → Credenciais de API).
 *
 * Três regras deles moldam este arquivo:
 *
 * 1. `orderId` é a chave do pedido — o MESMO id nas três atualizações
 *    (waiting_payment → paid → refunded). É assim que a Utmify atualiza em vez
 *    de criar três vendas.
 * 2. `createdAt` é em UTC e IMUTÁVEL entre as atualizações. Por isso sai sempre
 *    de `transacao.criadoEm`, nunca de "agora".
 * 3. Dinheiro em centavos inteiros.
 */
@Injectable()
export class UtmifyClient {
  private readonly logger = new Logger(UtmifyClient.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    const v = this.config.get<string>('UTMIFY_BASE_URL');
    return (v && v.trim() !== '' ? v.trim() : 'https://api.utmify.com.br').replace(
      /\/+$/,
      '',
    );
  }

  /**
   * `2026-08-06 14:03:22` em UTC — formato exigido pela Utmify.
   *
   * NÃO reaproveita a `dataHoraBr` do callback ao lojista: aquela é Brasília
   * (o que o lojista vê no extrato) e mandar horário local aqui jogaria a venda
   * três horas para trás no relatório de campanha.
   */
  private static utc(data: Date): string {
    return data.toISOString().slice(0, 19).replace('T', ' ');
  }

  /**
   * Corpo do pedido no contrato da Utmify.
   *
   * Público (em vez de privado) porque o botão "Testar" da tela monta um pedido
   * fictício com o mesmo código — testar por um caminho diferente do de produção
   * validaria a coisa errada.
   */
  static montarCorpo(pedido: PedidoVenda, status: string, teste: boolean) {
    const pago = status === STATUS_REMOTO_PEDIDO.PAID || status === STATUS_REMOTO_PEDIDO.REFUNDED;

    return {
      orderId: pedido.idPedido,
      platform: 'VPay',
      paymentMethod: 'pix',
      status,
      createdAt: UtmifyClient.utc(pedido.criadoEm),
      // `approvedDate` continua preenchida no refund: a venda foi aprovada e
      // depois devolvida — zerar faria a Utmify perder a conversão original.
      approvedDate: pago && pedido.pagoEm ? UtmifyClient.utc(pedido.pagoEm) : null,
      refundedAt:
        status === STATUS_REMOTO_PEDIDO.REFUNDED && pedido.devolvidoEm
          ? UtmifyClient.utc(pedido.devolvidoEm)
          : null,
      customer: {
        name: pedido.cliente.nome,
        email: pedido.cliente.email,
        phone: pedido.cliente.telefone,
        document: pedido.cliente.documento,
        country: 'BR',
      },
      products: pedido.itens.map((i) => ({
        id: i.id,
        name: i.titulo,
        planId: null,
        planName: null,
        quantity: i.quantidade,
        priceInCents: i.valorUnitarioCentavos,
      })),
      trackingParameters: {
        src: pedido.rastreio.src ?? null,
        sck: pedido.rastreio.sck ?? null,
        utm_source: pedido.rastreio.utm_source ?? null,
        utm_campaign: pedido.rastreio.utm_campaign ?? null,
        utm_medium: pedido.rastreio.utm_medium ?? null,
        utm_content: pedido.rastreio.utm_content ?? null,
        utm_term: pedido.rastreio.utm_term ?? null,
      },
      commission: {
        totalPriceInCents: pedido.valorBrutoCentavos,
        gatewayFeeInCents: pedido.tarifaCentavos,
        userCommissionInCents: pedido.liquidoLojistaCentavos,
      },
      isTest: teste,
    };
  }

  /**
   * O que a Utmify recusa e nós conseguimos ver antes de gastar uma chamada.
   *
   * Devolve o motivo, ou `null` se está tudo certo. É preferível registrar a
   * falha com a explicação do que falta do que mandar dado inventado só para
   * passar na validação deles — nome e e-mail aqui são do COMPRADOR.
   */
  static validar(pedido: PedidoVenda): string | null {
    if (!pedido.cliente.nome?.trim() || !pedido.cliente.email?.trim()) {
      return (
        'A Utmify exige nome e e-mail do comprador. Envie `pagador.nome` e ' +
        '`pagador.email` na criação da cobrança para esta venda ser rastreada.'
      );
    }
    if (!pedido.itens.length) {
      return 'Venda sem itens: a Utmify exige ao menos um produto no pedido.';
    }
    if (pedido.liquidoLojistaCentavos <= 0) {
      return 'Valor líquido do lojista zerado — a Utmify recusa comissão igual a zero.';
    }
    return null;
  }

  async enviar(envio: EnvioApp): Promise<ResultadoEnvio> {
    // A credencial é opcional no contrato neutro (há app que não tem nenhuma),
    // mas aqui ela é o `x-api-token` — sem ela a chamada é 401 garantido.
    if (!envio.token) {
      throw new ErroEnvioIntegracao(
        'Integração sem credencial: cadastre o x-api-token da Utmify.',
        true,
      );
    }

    const motivo = UtmifyClient.validar(envio.pedido);
    if (motivo) throw new ErroEnvioIntegracao(motivo, true);

    const url = `${this.baseUrl()}/api-credentials/orders`;
    const corpo = UtmifyClient.montarCorpo(envio.pedido, envio.status, envio.teste);
    const inicio = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-token': envio.token,
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      // Timeout/rede: retentável — o pedido pode não ter chegado, e reenviar o
      // mesmo `orderId` com o mesmo status é idempotente do lado deles.
      throw new ErroEnvioIntegracao(
        `Utmify inacessível: ${e instanceof Error ? e.message : String(e)}`,
        false,
        undefined,
        undefined,
        Date.now() - inicio,
      );
    }

    const latenciaMs = Date.now() - inicio;
    const texto = (await res.text()).slice(0, 2000);

    if (!res.ok) {
      // 4xx é definitivo: payload recusado, token inválido ou fora da janela
      // (7 dias para pedido novo, 45 para devolução). Retentar não conserta e
      // ainda esconde o erro real do lojista atrás de 5 tentativas.
      const definitivo = res.status >= 400 && res.status < 500;
      this.logger.warn(
        `Utmify HTTP ${res.status} pedido=${envio.pedido.idPedido} ` +
          `status=${envio.status}: ${texto.slice(0, 300)}`,
      );
      throw new ErroEnvioIntegracao(
        `Utmify respondeu HTTP ${res.status}: ${texto.slice(0, 500)}`,
        definitivo,
        res.status,
        texto,
        latenciaMs,
      );
    }

    return { statusHttp: res.status, corpoResposta: texto, latenciaMs };
  }
}
