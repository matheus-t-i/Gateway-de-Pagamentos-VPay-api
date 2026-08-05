import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { ipAllowed } from '../ip-allowlist.util';
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
  ProviderStatus,
  VerifyTransportInput,
} from '../payment-provider.port';
import { money } from '../../shared';

/**
 * Valorion — liquidante real de PIX (https://app.valorion.com.br/documentacao/).
 *
 * Dois hosts: o painel (`app.valorion.com.br`, autenticação Basic) responde
 * consulta de status, saldo e devolução; a fila de cash-in/out
 * (`api-fila-cash-in-out.onrender.com`, autenticação `x-api-key` + `X-Pix-Key`)
 * cria cobrança e saque. O saque é em duas etapas: auth (token Bearer com
 * validade de 180s) e create — o token é pedido a cada saque, sem cache.
 *
 * Credenciais: lidas de `contas_provedor.credenciaisCriptografadas` com
 * fallback nos envs `VALORION_*` — é o fallback que permite testar preenchendo
 * só o `.env`, sem recadastrar a conta no admin.
 */
@Injectable()
export class ValorionPaymentProvider implements PaymentProviderPort {
  readonly code = 'valorion';
  private readonly logger = new Logger(ValorionPaymentProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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
    const v = this.cred(c, 'apiKey', 'VALORION_API_KEY');
    if (!v) throw new Error('Valorion: VALORION_API_KEY/credencial apiKey ausente');
    return v;
  }

  private pixKey(c: Record<string, unknown>): string {
    const v = this.cred(c, 'pixKey', 'VALORION_PIX_KEY');
    if (!v) throw new Error('Valorion: VALORION_PIX_KEY/credencial pixKey ausente');
    return v;
  }

  /** Basic dos endpoints do painel; sem valor próprio, é o base64 da apiKey. */
  private basicKey(c: Record<string, unknown>): string {
    return (
      this.cred(c, 'basicKey', 'VALORION_BASIC_KEY') ??
      Buffer.from(this.apiKey(c), 'utf8').toString('base64')
    );
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
    // `api` é o prefixo global do main.ts — API_PUBLIC_URL é só a origem
    // (ex.: https://abc.ngrok-free.app), sem caminho.
    const url = `${base.replace(/\/+$/, '')}/api/webhooks/valorion/${rota}`;
    const token = this.env('VALORION_WEBHOOK_TOKEN');
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  }

  private async request(params: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    const res = await fetch(params.url, {
      method: params.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...params.headers,
      },
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: AbortSignal.timeout(params.timeoutMs ?? 20000),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new Error(
        `Valorion HTTP ${res.status} em ${params.url.split('?')[0]}: ${text.slice(0, 500)}`,
      );
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

    // A Valorion exige nome/e-mail/CPF válidos do pagador. Venda pela API
    // pública traz o pagador; depósito de painel envia o titular; o fallback
    // do .env cobre teste manual sem pagador informado.
    const nome =
      input.pagador?.nome ?? this.env('VALORION_PAGADOR_PADRAO_NOME');
    const email =
      input.pagador?.email ?? this.env('VALORION_PAGADOR_PADRAO_EMAIL');
    const cpf = (
      input.pagador?.documento ?? this.env('VALORION_PAGADOR_PADRAO_CPF') ?? ''
    ).replace(/\D/g, '');
    if (!nome || !email || !cpf) {
      throw new Error(
        'Valorion exige nome, e-mail e CPF do pagador — informe `pagador` na cobrança ' +
          'ou configure VALORION_PAGADOR_PADRAO_* no .env',
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
        ...(input.pagador?.telefone
          ? { phone: input.pagador.telefone.replace(/\D/g, '') }
          : {}),
        externaRef: input.referenciaExterna ?? input.idTransacaoPrivado,
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
      // Antifraude da Valorion pede o IP do pagador; a API pública não o
      // repassa hoje, então vai o placeholder configurável.
      ip: this.env('VALORION_PAGADOR_PADRAO_IP') ?? '127.0.0.1',
      metadata: input.idTransacaoPublico,
      traceable: false,
    };

    const resp = await this.request({
      method: 'POST',
      url: `${this.filaUrl()}/v2/pix/charge`,
      headers: {
        'x-api-key': this.apiKey(c),
        'X-Pix-Key': this.pixKey(c),
      },
      body,
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
    const authHeaders = {
      'X-API-Key': this.apiKey(c),
      'X-Pix-Key': this.pixKey(c),
    };

    // Etapa 1 — token Bearer (expira em 180s, pedido a cada saque).
    const auth = await this.request({
      method: 'POST',
      url: `${this.filaUrl()}/v2/pix/transaction/auth`,
      headers: authHeaders,
    });
    const token = String(auth.access_token ?? '');
    if (!token) {
      throw new Error(`Valorion cash-out auth sem access_token: ${JSON.stringify(auth).slice(0, 300)}`);
    }

    const tipoMap: Record<string, string> = {
      CPF: 'CPF',
      CNPJ: 'CNPJ',
      EMAIL: 'EMAIL',
      TELEFONE: 'PHONE',
      ALEATORIA: 'RANDOM',
    };

    // Etapa 2 — criação do saque.
    const resp = await this.request({
      method: 'POST',
      url: `${this.filaUrl()}/v2/pix/transaction/create`,
      headers: { ...authHeaders, Authorization: `Bearer ${token}` },
      body: {
        amount: Number(input.valor.toFixed(2)),
        pixKey: input.chavePix,
        pixType: tipoMap[input.tipoChavePix.toUpperCase()] ?? 'RANDOM',
        beneficiaryName: input.nomeBeneficiario ?? '',
        beneficiaryDocument: (input.documentoBeneficiario ?? '').replace(/\D/g, ''),
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

    return {
      status,
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

  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    const c = input.credenciais;
    const sellerId = this.cred(c, 'sellerId', 'VALORION_SELLER_ID');
    if (!sellerId) {
      throw new Error('Valorion: VALORION_SELLER_ID/credencial sellerId ausente para devolução');
    }

    // A devolução referencia a `externalreference` DELES, que só chega no
    // webhook de pagamento — buscar lá; sem webhook, tentar com o próprio id.
    const wh = await this.prisma.webhookRecebidoProvedor.findFirst({
      where: {
        provedor: { codigo: this.code },
        conteudo: { path: ['idtransaction'], equals: input.idTransacaoLiquidante },
      },
      orderBy: { id: 'desc' },
    });
    const conteudo = wh?.conteudo as Record<string, unknown> | undefined;
    const externalReference = String(
      conteudo?.externalreference ?? input.idTransacaoLiquidante,
    );

    const resp = await this.request({
      method: 'POST',
      url: `${this.baseUrl()}/api/v1/gateway/api/refund/`,
      headers: { Authorization: `Basic ${this.basicKey(c)}` },
      body: { id: Number(sellerId), external_reference: externalReference },
    });

    if (String(resp.status ?? '') !== 'success') {
      throw new Error(`Valorion recusou a devolução: ${JSON.stringify(resp).slice(0, 500)}`);
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
      throw new UnauthorizedException('IP não permitido para webhook do provedor');
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
