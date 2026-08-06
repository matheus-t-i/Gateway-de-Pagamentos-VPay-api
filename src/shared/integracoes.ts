/**
 * INTEGRAÇÕES DO LOJISTA (apps conectados) — fonte única.
 *
 * Aqui mora o vocabulário que API e painel compartilham sobre os apps que o
 * lojista pluga na conta dele (`/desenvolvedores/integracoes`). Espelhado em
 * `Gateway-de-Pagamentos-VPay-web/src/lib/integracoes.ts`: a tela é desenhada a
 * partir do `CATALOGO_INTEGRACOES`, então app novo entra aqui e aparece lá sem
 * markup novo.
 *
 * Diferença para o callback ao lojista (`callback-lojista.ts`): lá o contrato é
 * NOSSO e o destino é o servidor do cliente. Aqui o contrato é DELES — quem
 * dita nome de campo, status e formato de data é a plataforma de destino. Por
 * isso o catálogo carrega CAPACIDADES por app (tem credencial? aceita envio de
 * teste?) em vez de assumir que todo app funciona como o primeiro que ligamos.
 */

export const TIPO_INTEGRACAO = {
  UTMIFY: 'UTMIFY',
  XTRACKY: 'XTRACKY',
} as const;
export type TipoIntegracaoValor =
  (typeof TIPO_INTEGRACAO)[keyof typeof TIPO_INTEGRACAO];

/**
 * Eventos que o lojista assina por integração (coluna `eventos`), no mesmo
 * espírito do `tiposEvento` do webhook. Lista vazia = todos.
 *
 * Nomes próprios em vez de reusar `EVENTOS_LOJISTA`: `pedido.criado` não existe
 * como callback (a criação da cobrança devolve tudo na resposta síncrona), e
 * pendurar um evento novo no `EVENTOS_LOJISTA` faria todo webhook com
 * `tiposEvento: []` — e todo `urlCallback` — passar a receber uma entrega que
 * nunca receberam. Isso é mudança do contrato público, não de integração.
 */
export const EVENTOS_INTEGRACAO = {
  /** Cobrança gerada, aguardando o pagador. */
  PEDIDO_CRIADO: 'pedido.criado',
  /** Cash-in pago e creditado. */
  PEDIDO_PAGO: 'pedido.pago',
  /** MED aceito / devolução concluída. */
  PEDIDO_DEVOLVIDO: 'pedido.devolvido',
} as const;
export type EventoIntegracao =
  (typeof EVENTOS_INTEGRACAO)[keyof typeof EVENTOS_INTEGRACAO];

export const ROTULO_EVENTO_INTEGRACAO: Record<EventoIntegracao, string> = {
  [EVENTOS_INTEGRACAO.PEDIDO_CRIADO]: 'PIX gerado',
  [EVENTOS_INTEGRACAO.PEDIDO_PAGO]: 'Pago',
  [EVENTOS_INTEGRACAO.PEDIDO_DEVOLVIDO]: 'Devolvido (MED)',
};

export const TODOS_EVENTOS_INTEGRACAO: EventoIntegracao[] =
  Object.values(EVENTOS_INTEGRACAO);

/**
 * `status` do pedido no app de destino. Vocabulário DELES — não traduzir nem
 * reaproveitar `SITUACAO_TRANSACAO` aqui.
 *
 * Os três valores são idênticos na Utmify e na XTracky, então o mapa abaixo é
 * global. Se um app futuro usar literais próprios, o lookup desce para DENTRO
 * do laço por integração (`IntegracoesService.notificar`) e o mapa ganha a
 * dimensão do app — a unique `(integracao, transacao, status_remoto)` continua
 * segura porque `integracaoId` já fixa de qual app é aquele status.
 *
 * `refused`/`failed` (recusa de pagamento) e `chargedback` existem nos dois
 * apps e ficam de fora de propósito: cobrança PIX que nenhuma adquirente gerou
 * é falha técnica NOSSA, e jogar isso no funil estragaria a taxa de conversão
 * do lojista com um problema que não é dele.
 */
export const STATUS_REMOTO_PEDIDO = {
  WAITING_PAYMENT: 'waiting_payment',
  PAID: 'paid',
  REFUNDED: 'refunded',
} as const;
export type StatusRemotoPedido =
  (typeof STATUS_REMOTO_PEDIDO)[keyof typeof STATUS_REMOTO_PEDIDO];

/** Evento assinado pelo lojista → `status` enviado ao app. */
export const STATUS_REMOTO_POR_EVENTO: Record<EventoIntegracao, StatusRemotoPedido> = {
  [EVENTOS_INTEGRACAO.PEDIDO_CRIADO]: STATUS_REMOTO_PEDIDO.WAITING_PAYMENT,
  [EVENTOS_INTEGRACAO.PEDIDO_PAGO]: STATUS_REMOTO_PEDIDO.PAID,
  [EVENTOS_INTEGRACAO.PEDIDO_DEVOLVIDO]: STATUS_REMOTO_PEDIDO.REFUNDED,
};

/**
 * Parâmetros de rastreio de campanha que viajam da página de vendas até a
 * cobrança (bloco `rastreio` da API pública).
 *
 * Os nomes ficam LITERAIS (`utm_source`, `src`, `sck`) e não traduzidos: é o
 * que o lojista recebe pronto do pixel e da URL do anúncio. Um `origem`/
 * `campanha` em português obrigaria todo integrador a manter um de-para só
 * para conversar com a gente.
 *
 * Atenção ao `utm_source`: para a Utmify ele é a origem do tráfego
 * ("facebook"), mas para a XTracky é o LeadId gerado pelo script deles
 * (`TT-1763007625226-yn4xita3qylwh`), que sobrescreve o utm_source original na
 * URL. Por isso o valor é sempre repassado CRU — normalizar quebraria a
 * atribuição de um app para "arrumar" o outro.
 */
export const CAMPOS_RASTREIO = [
  'utm_source',
  'utm_campaign',
  'utm_medium',
  'utm_content',
  'utm_term',
  'src',
  'sck',
] as const;
export type CampoRastreio = (typeof CAMPOS_RASTREIO)[number];
export type ParametrosRastreio = Partial<Record<CampoRastreio, string | null>>;

/** Descrição de um app conectável. A tela do painel é desenhada a partir daqui. */
export type AppIntegracao = {
  tipo: TipoIntegracaoValor;
  nome: string;
  /** Uma linha: o que o app faz. Aparece no card da vitrine. */
  resumo: string;
  descricao: string;
  site: string;
  /**
   * Arquivo da marca do app, servido pelo painel (`web/public/apps/…`).
   * Vazio = o card usa o monograma colorido como fallback, e basta soltar o
   * arquivo oficial na pasta para ele passar a aparecer sem mexer em código.
   */
  logo: string;
  /** Cor da marca: fundo do monograma e realce do card. */
  corMarca: string;
  /**
   * Credencial exigida pelo app, ou `null` quando o app não tem nenhuma.
   *
   * `null` é um caso real, não uma folga: a XTracky identifica a conta pelo
   * LeadId que vem dentro do próprio pedido e não aceita header de
   * autenticação. Exigir "algum" segredo obrigaria o lojista a inventar 8
   * caracteres de lixo e o painel passaria a exibir "credencial configurada"
   * para uma integração que não tem credencial nenhuma.
   */
  credencial: { rotulo: string; ondeObter: string } | null;
  /**
   * O app aceita envio marcado como TESTE (que ele valida e não grava).
   *
   * Sem isso, "modo teste" e o botão "Testar" produziriam conversão REAL no
   * relatório do lojista — e, na XTracky, ainda queimariam o par
   * `orderId + utm_source` do dedupe deles, que não volta atrás.
   */
  suportaTeste: boolean;
  /** Eventos que este app entende. */
  eventos: EventoIntegracao[];
  /** Marcados por padrão ao conectar. Vazio = todos os `eventos`. */
  eventosPadrao: EventoIntegracao[];
  /** Aviso mostrado no formulário — o que o lojista precisa saber antes de ligar. */
  observacao?: string;
};

export const CATALOGO_INTEGRACOES: AppIntegracao[] = [
  {
    tipo: TIPO_INTEGRACAO.UTMIFY,
    nome: 'Utmify',
    resumo: 'Rastreio de campanha e ROI de tráfego pago',
    descricao:
      'Envia suas vendas para a Utmify com os parâmetros de campanha, para medir o ROI real de cada anúncio.',
    site: 'https://utmify.com.br',
    logo: '/apps/utmify.svg',
    corMarca: '#7C3AED',
    credencial: {
      rotulo: 'Credencial de API (x-api-token)',
      ondeObter:
        'Utmify → Integrações → Webhooks → Credenciais de API → Adicionar credencial',
    },
    suportaTeste: true,
    eventos: TODOS_EVENTOS_INTEGRACAO,
    eventosPadrao: TODOS_EVENTOS_INTEGRACAO,
  },
  {
    tipo: TIPO_INTEGRACAO.XTRACKY,
    nome: 'Xtracky',
    resumo: 'Conversões e otimização de campanha por LeadId',
    descricao:
      'Envia suas vendas para a Xtracky usando o LeadId que o script dela injeta na URL, para atribuir a conversão à campanha e alimentar a otimização dos anúncios.',
    site: 'https://xtracky.com',
    logo: '/apps/xtracky.svg',
    corMarca: '#0EA5E9',
    // Não tem: o endpoint de conversão não aceita header de autenticação e a
    // conta é resolvida pelo LeadId que vem no próprio pedido.
    credencial: null,
    // Não tem `isTest`: qualquer envio de teste vira conversão real.
    suportaTeste: false,
    eventos: TODOS_EVENTOS_INTEGRACAO,
    /**
     * Só o "pago" por padrão. O dedupe da Xtracky é por `orderId + utm_source`
     * e a documentação deles não deixa claro se o `status` entra na chave — se
     * não entrar, o primeiro envio (o "PIX gerado") consumiria o par e o
     * Purchase, que é o que sustenta o ROI do lojista, nunca chegaria. Nascer
     * só com o pago é o default que não pode dar errado; o lojista marca os
     * outros dois quando quiser, ciente disso.
     */
    eventosPadrao: [EVENTOS_INTEGRACAO.PEDIDO_PAGO],
    observacao:
      'A Xtracky identifica a venda pelo LeadId que o script dela grava em utm_source (e em sck) — então a cobrança precisa ser criada com o bloco `rastreio`. Marcar mais de um evento pode fazer a Xtracky descartar os seguintes: o dedupe dela é por pedido + LeadId, sem considerar o status.',
  },
];

export function appIntegracao(tipo: string): AppIntegracao | undefined {
  return CATALOGO_INTEGRACOES.find((a) => a.tipo === tipo);
}

/** Eventos marcados ao conectar um app. */
export function eventosPadraoDoApp(tipo: string): EventoIntegracao[] {
  const app = appIntegracao(tipo);
  if (!app) return TODOS_EVENTOS_INTEGRACAO;
  return app.eventosPadrao.length ? app.eventosPadrao : app.eventos;
}
