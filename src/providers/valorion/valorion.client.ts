import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { envApiKeyValorion } from './valorion.codigos';
import { ipAllowed, mensagemIpNaoPermitido } from '../ip-allowlist.util';
import {
  CreateCashOutInput,
  CreateCashOutResult,
  CreateChargeInput,
  CreateChargeResult,
  CreateRefundInput,
  CreateRefundResult,
  GetBalanceResult,
  GetStatusResult,
  ErroAntesDoEnvioError,
  PaymentProviderPort,
  ProviderStatus,
  RecusaAdquirenteError,
  VerifyTransportInput,
} from '../payment-provider.port';
import { digitosTelefoneChavePix, money, normalizarDocumento } from '../../shared';
import { origemApiPublica } from '../../common/api-prefix';
import { extrairValorDePayload } from '../valor-remoto.util';

/**
 * 4xx no `/auth` que recusam ESTE saque — chave de destino recusada ou
 * cash-out desligado na conta Valorion. Retry dá o mesmo não; o processor
 * encerra em FALHA e devolve o saldo. Blip da nossa API key NÃO entra aqui.
 */
export function recusaDefinitivaNoAuth(erro: RecusaAdquirenteError): boolean {
  const m = erro.message.toLowerCase();
  return (
    m.includes('cash-out desabilitado') ||
    m.includes('x-pix-key inválida') ||
    m.includes('x-pix-key invalida') ||
    m.includes('não pertence a este usuário') ||
    m.includes('nao pertence a este usuario') ||
    m.includes('acesso bloqueado')
  );
}

/**
 * Chave de destino no formato da VALORION — que NÃO é o E.164 dos callers:
 * a doc deles pede "apenas números para CPF/CNPJ/PHONE", e o `/auth` recusa
 * `+5562…`/`5562…` com 401 "X-Pix-Key inválida" (confirmado em produção,
 * ago/2026). TELEFONE sai como DDD+número (`62981809423`); os demais tipos
 * seguem o valor recebido. Idempotente: aceita tanto o valor gravado quanto
 * o E.164 que o processor/tesouraria já montam.
 */
export function chavePixParaValorion(tipo: string, chave: string): string {
  if ((tipo ?? '').toUpperCase() !== 'TELEFONE') return (chave ?? '').trim();
  const dddNumero = digitosTelefoneChavePix(chave);
  return dddNumero.length >= 10 ? dddNumero : (chave ?? '').trim();
}

/**
 * Valorion — liquidante real de PIX (https://app.valorion.com.br/documentacao/).
 *
 * Dois hosts: o painel (`app.valorion.com.br`, autenticação Basic) responde
 * consulta de status, saldo e devolução; a fila de cash-in/out
 * (`api-fila-cash-in-out.onrender.com`) cria cobrança (`x-api-key`) e saque
 * (`x-api-key` + `X-Pix-Key` = chave de **destino**, que precisa estar
 * AUTORIZADA na conta Valorion — cadastro prévio com o time deles; telefone
 * em dígitos DDD+número, ver `chavePixParaValorion`).
 *
 * Credenciais: `contas_provedor.credenciaisCriptografadas` com fallback
 * `VALORION_API_KEY` / `VALORION_02_API_KEY` … `VALORION_05_API_KEY` conforme
 * o `code` desta instância. Hosts e token de webhook são compartilhados.
 * Basic do painel = base64 da apiKey; seller do refund via getCompany.
 * Destino do saque automático de tesouraria: `TESOURARIA_CHAVE_PIX` = nome
 * de outra env com a chave real; tipo/titular no banco.
 *
 * Cinco adquirentes (`valorion` … `valorion_05`) = cinco instâncias no
 * registry, cada uma com seu code. Sem fila própria — o payload leva `provider`.
 */
export class ValorionPaymentProvider implements PaymentProviderPort {
  private readonly logger: Logger;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    readonly code: string = 'valorion',
  ) {
    this.logger = new Logger(`Valorion:${this.code}`);
  }

  // ---------------------------------------------------------------- helpers

  private env(name: string): string | undefined {
    const v = this.config.get<string>(name);
    return v && v.trim() !== '' ? v.trim() : undefined;
  }

  private cred(credenciais: Record<string, unknown>, key: string, envName: string) {
    const v = credenciais[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    return this.env(envName);
  }

  private apiKey(c: Record<string, unknown>): string {
    const envName = envApiKeyValorion(this.code);
    const v = this.cred(c, 'apiKey', envName);
    if (!v) {
      throw new Error(
        `Valorion (${this.code}): ${envName}/credencial apiKey ausente`,
      );
    }
    return v;
  }

  /** Basic do painel Valorion = API key em base64 (doc oficial). Sem env aparte. */
  private basicKey(c: Record<string, unknown>): string {
    return Buffer.from(this.apiKey(c), 'utf8').toString('base64');
  }

  /**
   * ID numérico da empresa na Valorion (`dados_seller.empresa.id`), exigido no
   * body do refund. Resolvido na hora via getCompany — não há VALORION_SELLER_ID.
   * Cache por apiKey: cada uma das 5 contas é uma empresa diferente.
   */
  private readonly sellerIdPorApiKey = new Map<string, number>();

  private async resolverSellerId(c: Record<string, unknown>): Promise<number> {
    const chave = this.apiKey(c);
    const cached = this.sellerIdPorApiKey.get(chave);
    if (cached !== undefined) return cached;
    const resp = await this.request({
      method: 'GET',
      url: `${this.baseUrl()}/api/s1/getCompany/`,
      headers: { Authorization: `Basic ${this.basicKey(c)}` },
    });
    const empresa = (resp.dados_seller as Record<string, unknown> | undefined)
      ?.empresa as Record<string, unknown> | undefined;
    const id = Number(empresa?.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ErroAntesDoEnvioError(
        `Valorion (${this.code}): getCompany sem dados_seller.empresa.id — ${JSON.stringify(resp).slice(0, 300)}`,
      );
    }
    this.sellerIdPorApiKey.set(chave, id);
    return id;
  }

  private baseUrl(): string {
    return this.env('VALORION_BASE_URL') ?? 'https://app.valorion.com.br';
  }

  private filaUrl(): string {
    return this.env('VALORION_FILA_URL') ?? 'https://api-fila-cash-in-out.onrender.com';
  }

  /**
   * URL de postback desta API, vista de fora. Sem `API_PUBLIC_URL` o campo
   * segue obrigatório na Valorion, então a criação falha cedo e com mensagem
   * clara em vez de nascer uma cobrança que nunca receberá confirmação.
   */
  private postbackUrl(rota: 'pix-in' | 'pix-out'): string {
    const base = this.env('API_PUBLIC_URL');
    if (!base) {
      throw new Error(
        'Valorion: API_PUBLIC_URL ausente — configure a URL pública da API para receber postbacks',
      );
    }
    // Prefixo global `/api` entra AQUI. `origemApiPublica` remove `/api` se
    // alguém colocou na env (Render com URL "da API"), senão vira /api/api/.
    const url = `${origemApiPublica(base)}/api/webhooks/${this.code}/${rota}`;
    const token = this.env('VALORION_WEBHOOK_TOKEN');
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  private async request(params: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const res = await fetch(params.url, {
      method: params.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...params.headers,
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: params.signal ?? AbortSignal.timeout(params.timeoutMs ?? 20000),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const mensagem = `Valorion HTTP ${res.status} em ${params.url.split('?')[0]}: ${text.slice(0, 500)}`;
      /**
       * 4xx é recusa EXPLÍCITA: a Valorion recebeu, entendeu e disse não —
       * então a ordem não foi executada e repetir dá o mesmo erro. Quem chama
       * pode encerrar a operação com segurança.
       *
       * 429/408 ficam de fora: são "tente de novo mais tarde", não recusa.
       * 5xx e timeout também não entram aqui — nesses casos não se sabe o que
       * aconteceu do outro lado, e num saque essa dúvida CONGELA o fluxo.
       */
      if (res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status)) {
        throw new RecusaAdquirenteError(mensagem, {
          statusHttp: res.status,
          dadosResposta: json,
        });
      }
      throw new Error(mensagem);
    }
    return json;
  }

  /**
   * A Valorion fala vários dialetos de status (webhook em inglês, consulta em
   * português). Tudo converge aqui para o vocabulário do port.
   */
  static mapStatus(raw: unknown, tipo?: unknown): ProviderStatus {
    const s = String(raw ?? '').toUpperCase().trim();
    const cashOut = String(tipo ?? '').toUpperCase().includes('OUT');
    if (
      ['PAID_OUT', 'PAID', 'PAGO', 'PAGA', 'CONCLUIDO', 'CONCLUIDA', 'COMPLETED', 'APPROVED', 'LIQUIDADA', 'SUCCESS'].includes(s)
    ) {
      // Os processors aceitam PAID e COMPLETED; manter a semântica por direção.
      return cashOut ? 'COMPLETED' : 'PAID';
    }
    if (
      ['AGUARDANDO_PAGAMENTO', 'WAITING_FOR_APPROVAL', 'WAITING_PAYMENT', 'PENDING', 'PENDENTE', 'PROCESSANDO', 'PROCESSING'].includes(s)
    ) {
      return 'WAITING_PAYMENT';
    }
    if (['FAILED', 'FALHA', 'ERROR', 'ERRO'].includes(s)) return 'FAILED';
    if (['CANCELED', 'CANCELLED', 'CANCELADO', 'CANCELADA', 'EXPIRED', 'EXPIRADO'].includes(s)) {
      return 'CANCELLED';
    }
    if (['REFUNDED', 'REFUND', 'DEVOLVIDO', 'DEVOLVIDA', 'MED', 'CHARGEBACK'].includes(s)) {
      return 'REFUNDED';
    }
    return 'PENDING';
  }

  // ---------------------------------------------------------------- cash-in

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const c = input.credenciais;

    // A Valorion exige nome/e-mail/documento do pagador. Vêm da cobrança
    // (API pública ou depósito do painel) — sem pagador padrão no .env.
    const nome = input.pagador?.nome;
    const email = input.pagador?.email;
    const phone = (input.pagador?.telefone ?? '').replace(/\D/g, '');
    /**
     * `normalizarDocumento` e NÃO `replace(/\D/g, '')`: o segundo apaga letras,
     * e o CNPJ alfanumérico da Receita tem letras nas 12 primeiras posições —
     * o documento chegaria mutilado na liquidante, sem erro nenhum do nosso
     * lado.
     *
     * ⚠️ O campo da Valorion se chama `cpf` e não há equivalente para CNPJ.
     * Nosso contrato aceita os dois (o pagador pode ser PJ), mas o
     * comportamento dela com 14 posições não está confirmado — é o que
     * investigar antes de prometer PIX com pagador PJ nesta adquirente.
     */
    const cpf = normalizarDocumento(input.pagador?.documento ?? '');
    if (!nome || !email || !cpf || phone.length < 10) {
      throw new Error(
        'Valorion exige nome, e-mail, CPF e telefone do pagador — informe `pagador` na cobrança',
      );
    }

    const expiresInDays = Math.max(
      1,
      Math.ceil((input.expiracaoSegundos ?? 86400) / 86400),
    );

    const endereco = input.pagador?.endereco as
      | Record<string, unknown>
      | undefined;

    const body: Record<string, unknown> = {
      amount: Number(input.valor.toFixed(2)),
      customer: {
        id: input.idTransacaoPublico,
        name: nome,
        email,
        cpf,
        phone,
        // SEMPRE o id PÚBLICO — nunca a `referenciaExterna` do lojista, nunca o
        // id privado. Duas razões, e as duas são de dinheiro:
        //
        // 1. UNICIDADE NA LIQUIDANTE. Com "cobrança nunca responde 409", a mesma
        //    `referenciaExterna` acumula N cobranças vivas (carrinho mudou, QR
        //    expirou, retry pós-FALHA). Mandá-la para cá criava DUAS cobranças na
        //    Valorion com o mesmo `external_reference` — e é exatamente essa a
        //    chave do refund (`createRefund`), que não tem idempotência. Devolução
        //    com chave ambígua é caminho de estorno em duplicidade.
        // 2. O ID PRIVADO NÃO SAI DAQUI. É interno (o callback e a API pública já
        //    só expõem o público — ver `EntregaWebhookService.montarCorpo`); esta
        //    linha era o único ponto em que ele cruzava a fronteira.
        //
        // O público serve para os dois papéis: é único por transação e já é o que
        // vai em `customer.id`/`metadata`, então o eco do postback casa por
        // `idTransacaoPublico` no `resolverTentativa` sem heurística nenhuma.
        externaRef: input.idTransacaoPublico,
        ...(endereco
          ? {
              address: {
                street: endereco.logradouro ?? endereco.street,
                streetNumber: endereco.numero ?? endereco.streetNumber,
                zipCode: String(endereco.cep ?? endereco.zipCode ?? '').replace(/\D/g, ''),
                neighborhood: endereco.bairro ?? endereco.neighborhood,
                city: endereco.cidade ?? endereco.city,
                state: endereco.uf ?? endereco.state,
                country: 'BR',
              },
            }
          : {}),
      },
      ...(input.itens?.length
        ? {
            items: input.itens.map((i) => ({
              title: i.titulo,
              quantity: i.quantidade,
              unitPrice: Number(money(String(i.valorUnitario)).toFixed(2)),
              tangible: i.tangivel,
            })),
          }
        : {}),
      pix: { expiresInDays },
      postbackUrl: this.postbackUrl('pix-in'),
      // Antifraude da Valorion pede IP; a API pública ainda não repassa o do
      // pagador — placeholder local até o contrato expor o campo.
      ip: '127.0.0.1',
      metadata: input.idTransacaoPublico,
      traceable: false,
    };

    const resp = await this.request({
      method: 'POST',
      url: `${this.filaUrl()}/v2/pix/charge`,
      headers: {
        'x-api-key': this.apiKey(c),
      },
      body,
      signal: input.signal,
    });

    const idTransacaoLiquidante = String(resp.idTransaction ?? '');
    const pixCopiaCola = String(resp.paymentCode ?? '');
    if (String(resp.status ?? '') !== 'success' || !idTransacaoLiquidante || !pixCopiaCola) {
      throw new Error(
        `Valorion não gerou a cobrança: ${JSON.stringify(resp).slice(0, 500)}`,
      );
    }

    return {
      idTransacaoLiquidante,
      pixCopiaCola,
      expiraEm: new Date(Date.now() + expiresInDays * 86400 * 1000),
      raw: resp,
    };
  }

  // --------------------------------------------------------------- cash-out

  async createCashOut(input: CreateCashOutInput): Promise<CreateCashOutResult> {
    const c = input.credenciais;
    // O header `X-Pix-Key` leva a chave de DESTINO deste saque (body `pixKey`
    // = mesma) — e a Valorion só autoriza chave PRÉ-CADASTRADA na conta
    // (cadastro via time deles); chave fora da lista volta 401 "não pertence
    // a este usuário", tratado como recusa definitiva.
    if (!input.chavePix?.trim()) {
      throw new ErroAntesDoEnvioError(
        'Valorion cash-out: chave PIX de destino ausente',
      );
    }
    const chaveDestino = chavePixParaValorion(
      input.tipoChavePix,
      input.chavePix,
    );
    const authHeaders = {
      'X-API-Key': this.apiKey(c),
      'X-Pix-Key': chaveDestino,
    };

    /**
     * Etapa 1 — token Bearer (expira em 180s, pedido a cada saque).
     *
     * Auth 4xx NÃO é tudo a mesma coisa:
     * - credencial NOSSA (API key rotacionada, 401 genérico) →
     *   `ErroAntesDoEnvioError`: nada saiu, retry é seguro e necessário;
     * - recusa DESTE saque/conta (`X-Pix-Key` inválida, cash-out desabilitado
     *   na Valorion) → `RecusaAdquirenteError`: retentar 5 vezes dá o mesmo
     *   não, e o saldo debitado ficaria preso em PROCESSANDO para sempre.
     */
    let auth: Record<string, unknown>;
    try {
      auth = await this.request({
        method: 'POST',
        url: `${this.filaUrl()}/v2/pix/transaction/auth`,
        headers: authHeaders,
      });
    } catch (e) {
      if (e instanceof RecusaAdquirenteError && recusaDefinitivaNoAuth(e)) {
        throw e;
      }
      throw new ErroAntesDoEnvioError(
        `Valorion cash-out: falha ao autenticar — ${e instanceof Error ? e.message : String(e)}`,
        e,
      );
    }
    const token = String(auth.access_token ?? '');
    if (!token) {
      throw new ErroAntesDoEnvioError(
        `Valorion cash-out auth sem access_token: ${JSON.stringify(auth).slice(0, 300)}`,
      );
    }

    const tipoMap: Record<string, string> = {
      CPF: 'CPF',
      CNPJ: 'CNPJ',
      EMAIL: 'EMAIL',
      TELEFONE: 'PHONE',
      ALEATORIA: 'RANDOM',
    };

    // Etapa 2 — criação do saque.
    // `externaRef` = id nosso: se o worker morrer entre o aceite e gravar
    // `idTransacaoLiquidante`, o postback ainda pode correlacionar pela ref.
    const resp = await this.request({
      method: 'POST',
      url: `${this.filaUrl()}/v2/pix/transaction/create`,
      headers: { ...authHeaders, Authorization: `Bearer ${token}` },
      body: {
        amount: Number(input.valor.toFixed(2)),
        pixKey: chaveDestino,
        pixType: tipoMap[input.tipoChavePix.toUpperCase()] ?? 'RANDOM',
        beneficiaryName: input.nomeBeneficiario ?? '',
        // `normalizarDocumento` pelo mesmo motivo do cash-in: `replace(/\D/g,'')`
        // apagaria as letras de um CNPJ alfanumérico e o DICT nunca casaria.
        beneficiaryDocument: normalizarDocumento(input.documentoBeneficiario ?? ''),
        externaRef: input.idTransacaoPrivado,
        postbackUrl: this.postbackUrl('pix-out'),
      },
    });

    const idTransacaoLiquidante = String(resp.idTransaction ?? '');
    if (String(resp.status ?? '') !== 'success' || !idTransacaoLiquidante) {
      throw new Error(
        `Valorion não criou o cash-out: ${JSON.stringify(resp).slice(0, 500)}`,
      );
    }
    return { idTransacaoLiquidante, raw: resp };
  }

  // ----------------------------------------------------------------- status

  async getStatus(params: {
    idTransacaoLiquidante?: string;
    idTransacaoPrivado: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetStatusResult> {
    if (!params.idTransacaoLiquidante) {
      // Sem o id da Valorion não há o que consultar — a Camada 1 deve falhar,
      // não confirmar às cegas.
      return { status: 'PENDING', raw: { erro: 'sem idTransacaoLiquidante' } };
    }
    const resp = await this.request({
      method: 'GET',
      url:
        `${this.baseUrl()}/api/s1/getTransaction/api/getTransactionStatus.php` +
        `?id_transaction=${encodeURIComponent(params.idTransacaoLiquidante)}`,
      headers: { Authorization: `Basic ${this.basicKey(params.credenciais)}` },
    });

    const status = ValorionPaymentProvider.mapStatus(resp.situacao ?? resp.status, resp.tipo);

    // O endToEnd não vem na consulta — vem no webhook; recuperar de lá quando
    // existir, para gravar o identificador fim-a-fim na transação PIX.
    let endToEndId: string | undefined;
    if (status === 'PAID' || status === 'COMPLETED') {
      const wh = await this.prisma.webhookRecebidoProvedor.findFirst({
        where: {
          provedor: { codigo: this.code },
          conteudo: { path: ['idtransaction'], equals: params.idTransacaoLiquidante },
        },
        orderBy: { id: 'desc' },
      });
      const conteudo = wh?.conteudo as Record<string, unknown> | undefined;
      if (conteudo?.endToEnd) endToEndId = String(conteudo.endToEnd);
    }

    const valor = extrairValorDePayload(resp) ?? undefined;

    return {
      status,
      valor,
      endToEndId,
      paidAt:
        status === 'PAID' || status === 'COMPLETED'
          ? resp.data_transacao
            ? new Date(String(resp.data_transacao).replace(' ', 'T') + '-03:00')
            : new Date()
          : undefined,
      raw: resp,
    };
  }

  // ----------------------------------------------------------------- refund

  /**
   * ⚠️ O endpoint de refund só recebe `{ id, external_reference }` — NÃO existe
   * chave de idempotência por devolução (o `idDevolucaoPublico` não entra na
   * request). Reenviar pode devolver DUAS vezes; por isso o processor congela
   * qualquer desfecho ambíguo em vez de retentar (mesma doutrina do cash-out).
   *
   * - `id` = seller na Valorion, resolvido via getCompany (não env).
   * - `external_reference` = `idTransacaoPublico` (o mesmo `externaRef` do create).
   *
   * A classificação dos erros segue o contrato do port:
   * - pré-envio (getCompany falhou) → `ErroAntesDoEnvioError` (nada saiu; retry OK);
   * - HTTP 4xx exceto 408/429 → `RecusaAdquirenteError` (via `request`);
   * - 200 com `status !== success` → `RecusaAdquirenteError` (resposta
   *   explícita deles: retry dá o mesmo não);
   * - timeout/5xx → Error cru (ambíguo — quem chama congela).
   */
  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    const c = input.credenciais;

    let sellerId: number;
    try {
      sellerId = await this.resolverSellerId(c);
    } catch (e) {
      if (e instanceof ErroAntesDoEnvioError) throw e;
      throw new ErroAntesDoEnvioError(
        `Valorion refund: falha ao resolver seller — ${
          e instanceof Error ? e.message : String(e)
        }`,
        e,
      );
    }

    // Mesma chave que mandamos no create (`customer.externaRef` / metadata).
    const externalReference = input.idTransacaoPublico;

    const resp = await this.request({
      method: 'POST',
      url: `${this.baseUrl()}/api/v1/gateway/api/refund/`,
      headers: { Authorization: `Basic ${this.basicKey(c)}` },
      body: { id: sellerId, external_reference: externalReference },
    });

    if (String(resp.status ?? '') !== 'success') {
      // 200 com corpo de erro: a Valorion respondeu e disse não — definitivo.
      throw new RecusaAdquirenteError(
        `Valorion recusou a devolução: ${JSON.stringify(resp).slice(0, 500)}`,
        { statusHttp: 200, dadosResposta: resp },
      );
    }
    return {
      identificadorDevolucaoProvedor: String(
        resp.rtrId ?? resp.idTransaction ?? input.idDevolucaoPublico,
      ),
      raw: resp,
    };
  }

  // ----------------------------------------------------------------- saldo

  async getBalance(params: {
    contaProvedorId: string;
    credenciais: Record<string, unknown>;
  }): Promise<GetBalanceResult> {
    const resp = await this.request({
      method: 'GET',
      url: `${this.baseUrl()}/api/s1/getsaldo/api/`,
      headers: { Authorization: `Basic ${this.basicKey(params.credenciais)}` },
    });
    const data = (resp.data ?? {}) as Record<string, unknown>;
    const disponivel = money(String(data.saldo_liquido ?? '0')).toDecimalPlaces(2);
    return {
      disponivel: disponivel.lt(0) ? money('0') : disponivel,
      // A Valorion não expõe saldo bloqueado na consulta.
      bloqueado: money('0'),
      moeda: 'BRL',
      raw: resp,
    };
  }

  // -------------------------------------------------------------- transporte

  /**
   * Camada 2. A Valorion não assina o postback — a defesa é allowlist de IP
   * (cadastrada no admin) + token secreto embutido na query do postbackUrl
   * (validado no controller) + a consulta de status (Camada 1).
   */
  async verifyTransport(input: VerifyTransportInput): Promise<boolean> {
    if (!ipAllowed(input.ip, input.allowedIps)) {
      // Resposta HTTP continua genérica em produção; o IP vai só ao log do
      // servidor — sem isto o 401 de allowlist é cego no Render.
      this.logger.warn(
        `Webhook IP fora da allowlist (recebido=${input.ip}; allowlist=${input.allowedIps.join(',') || '(vazia)'})`,
      );
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
