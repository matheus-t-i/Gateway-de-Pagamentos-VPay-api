import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvioApp, ErroEnvioIntegracao, PedidoVenda, ResultadoEnvio } from '../tipos';

/**
 * Xtracky — conversões para otimização de campanha (https://docs.xtracky.com).
 *
 * Mão única, igual à Utmify, mas o modelo é BEM diferente e três pontos
 * mandam neste arquivo:
 *
 * 1. **Não existe autenticação.** Nenhum header, nenhum segredo no corpo. Quem
 *    identifica a conta do lojista é o `utm_source` — que aqui NÃO é a origem
 *    do tráfego, e sim o **LeadId** que o script da Xtracky gera e grava na URL
 *    (`TT-1763007625226-yn4xita3qylwh`), sobrescrevendo o utm_source original.
 *    Por isso o valor é repassado CRU: normalizar, truncar ou "arrumar" para
 *    `facebook` manda a venda para o limbo.
 * 2. **A API aceita quase tudo com 202.** Corpo vazio, status inválido, rota
 *    inexistente — tudo responde 202. Não há validação do outro lado, então a
 *    checagem local em `validar()` é a ÚNICA que existe: sem ela, uma
 *    integração completamente quebrada ficaria 100% verde na tela do lojista.
 * 3. **Sucesso é 2xx, não `=== 200`.** Os exemplos PHP/Python da doc oficial
 *    testam `httpCode === 200`, mas o endpoint responde **202 Accepted**. Quem
 *    "consertar" este arquivo para comparar com 200 transforma todo envio em
 *    falha.
 *
 * O que 202 significa: "enfileirado". Não é confirmação de que a conversão foi
 * registrada — o único sinal de descarte é `duplicate: true` no corpo.
 */
@Injectable()
export class XtrackyClient {
  private readonly logger = new Logger(XtrackyClient.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string {
    const v = this.config.get<string>('XTRACKY_BASE_URL');
    return (v && v.trim() !== '' ? v.trim() : 'https://api.xtracky.com').replace(
      /\/+$/,
      '',
    );
  }

  /**
   * O LeadId da venda. `utm_source` é o campo principal; `sck` é o espelho que
   * o próprio script da Xtracky grava junto — e muitos checkouts brasileiros
   * propagam só ele. Sem nenhum dos dois não há o que atribuir.
   */
  static leadId(pedido: PedidoVenda): string | null {
    const utm = pedido.rastreio.utm_source?.trim();
    if (utm) return utm;
    const sck = pedido.rastreio.sck?.trim();
    return sck || null;
  }

  /**
   * Corpo no contrato da Xtracky: exatamente os 9 campos documentados.
   *
   * Nada de `products`, `commission`, `currency` ou data — não existem lá, e
   * campo extra pode entrar no hash de deduplicação deles.
   */
  static montarCorpo(pedido: PedidoVenda, status: string) {
    return {
      orderId: pedido.idPedido,
      // Inteiro em centavos, sem aspas. Valor BRUTO: a Xtracky mede receita de
      // campanha, não a nossa comissão.
      amount: pedido.valorBrutoCentavos,
      status,
      utm_source: XtrackyClient.leadId(pedido),
      platform: 'CUSTOM',
      leadName: pedido.cliente.nome,
      leadEmail: pedido.cliente.email,
      leadPhone: pedido.cliente.telefone,
      // Enviado como o lojista mandou. A doc mostra CPF com máscara no exemplo
      // mas não declara exigência — reformatar seria adivinhar.
      leadDocument: pedido.cliente.documento,
    };
  }

  /**
   * O que impede um envio inútil. Aqui isto não é otimização: como a Xtracky
   * responde 202 para qualquer coisa, é a única validação que vai existir.
   */
  static validar(pedido: PedidoVenda): string | null {
    if (!XtrackyClient.leadId(pedido)) {
      return (
        'Venda sem LeadId da Xtracky: a cobrança precisa ser criada com o bloco ' +
        '`rastreio` (`utm_source` ou `sck`) que o script da Xtracky grava na URL. ' +
        'Sem ele não há como atribuir esta venda a uma campanha.'
      );
    }
    if (pedido.valorBrutoCentavos <= 0) {
      return 'Valor da venda zerado — a Xtracky não registra conversão sem valor.';
    }
    return null;
  }

  async enviar(envio: EnvioApp): Promise<ResultadoEnvio> {
    const motivo = XtrackyClient.validar(envio.pedido);
    if (motivo) throw new ErroEnvioIntegracao(motivo, true);

    const url = `${this.baseUrl()}/api/integrations/api`;
    const corpo = XtrackyClient.montarCorpo(envio.pedido, envio.status);
    const inicio = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw new ErroEnvioIntegracao(
        `Xtracky inacessível: ${e instanceof Error ? e.message : String(e)}`,
        false,
        undefined,
        undefined,
        Date.now() - inicio,
      );
    }

    const latenciaMs = Date.now() - inicio;
    const texto = (await res.text()).slice(0, 2000);

    if (!res.ok) {
      /**
       * 4xx aqui é falha de TRANSPORTE (JSON malformado, corpo ausente) — ou
       * seja, bug nosso, que retentar não conserta.
       *
       * 429 e 408 são a exceção e precisam retentar: como não há credencial por
       * lojista, qualquer throttling deles é por IP — e TODOS os nossos
       * lojistas saem pelo mesmo IP do worker. Descartar um 429 como definitivo
       * jogaria fora as conversões de todo mundo por causa do pico de um.
       */
      const definitivo =
        res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
      this.logger.warn(
        `Xtracky HTTP ${res.status} pedido=${envio.pedido.idPedido} ` +
          `status=${envio.status}: ${texto.slice(0, 300)}`,
      );
      throw new ErroEnvioIntegracao(
        `Xtracky respondeu HTTP ${res.status}: ${texto.slice(0, 500)}`,
        definitivo,
        res.status,
        texto,
        latenciaMs,
      );
    }

    return {
      statusHttp: res.status,
      corpoResposta: texto,
      latenciaMs,
      avisoDescartado: XtrackyClient.descarte(texto),
    };
  }

  /**
   * `{"received":true,"duplicate":true}` volta com 2xx e significa que a
   * Xtracky DESCARTOU o pedido. Sem tratar isso, o histórico marcaria SUCESSO e
   * o lojista nunca saberia que a conversão não foi contabilizada — que é
   * exatamente o sintoma de o dedupe deles (`orderId` + LeadId) engolir o
   * segundo envio do mesmo pedido.
   */
  private static descarte(corpo: string): string | undefined {
    try {
      const json = JSON.parse(corpo) as { duplicate?: unknown };
      if (json.duplicate === true) {
        return (
          'A Xtracky recebeu mas DESCARTOU como duplicado (mesmo pedido + LeadId ' +
          'já enviado). A conversão pode não ter sido contabilizada — reenviar não resolve.'
        );
      }
    } catch {
      // Corpo não-JSON: sem informação de descarte, segue como sucesso normal.
    }
    return undefined;
  }
}
