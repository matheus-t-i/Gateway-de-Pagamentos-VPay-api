/**
 * Catálogo de permissões — FONTE ÚNICA do controle de acesso.
 *
 * Regras:
 * - NUNCA escrever string literal de permissão em controller/service. Usar
 *   `PERMISSOES.*`, do mesmo jeito que se usa `SITUACAO_*` em `situacoes.ts`.
 * - Um "recurso" corresponde a uma TELA do painel; cada recurso declara as
 *   ações que fazem sentido nele. O código da permissão é `<recurso>.<ação>`.
 * - O admin monta perfis livremente marcando permissões (matriz recurso × ação).
 *   Por isso o catálogo é o contrato entre API e painel: o painel desenha a
 *   matriz a partir de `GET /admin/perfis/catalogo`, que devolve isto aqui.
 *
 * Conta própria (`/auth/me`, `/auth/totp`, tela Configurações) NÃO é gateada:
 * bloquear o usuário de ver o próprio perfil ou de configurar o próprio 2FA
 * não protege nada e ainda permitiria travar a conta do próprio administrador.
 */

export const ACOES = {
  VER: 'ver',
  CRIAR: 'criar',
  EDITAR: 'editar',
  EXCLUIR: 'excluir',
  APROVAR: 'aprovar',
  DECIDIR: 'decidir',
  EXECUTAR: 'executar',
} as const;

export type Acao = (typeof ACOES)[keyof typeof ACOES];

export const ROTULO_ACAO: Record<Acao, string> = {
  [ACOES.VER]: 'Ver',
  [ACOES.CRIAR]: 'Criar',
  [ACOES.EDITAR]: 'Editar',
  [ACOES.EXCLUIR]: 'Excluir',
  [ACOES.APROVAR]: 'Aprovar',
  [ACOES.DECIDIR]: 'Decidir',
  [ACOES.EXECUTAR]: 'Executar',
};

export const PERMISSOES = {
  // ---- Operação (cliente) ----
  DASHBOARD_VER: 'dashboard.ver',

  TRANSACOES_VER: 'transacoes.ver',
  TRANSACOES_CRIAR: 'transacoes.criar',

  // ---- Conta ----
  ADQUIRENTES_VER: 'adquirentes.ver',
  ADQUIRENTES_EDITAR: 'adquirentes.editar',

  // ---- Desenvolvedores ----
  CHAVES_API_VER: 'chaves_api.ver',
  CHAVES_API_CRIAR: 'chaves_api.criar',
  CHAVES_API_EXCLUIR: 'chaves_api.excluir',

  WEBHOOKS_VER: 'webhooks.ver',
  WEBHOOKS_CRIAR: 'webhooks.criar',
  WEBHOOKS_EXCLUIR: 'webhooks.excluir',

  CHAVES_PIX_VER: 'chaves_pix.ver',
  CHAVES_PIX_CRIAR: 'chaves_pix.criar',
  CHAVES_PIX_EXCLUIR: 'chaves_pix.excluir',

  // ---- Administração ----
  ADMIN_APROVACOES_VER: 'admin.aprovacoes.ver',
  ADMIN_APROVACOES_APROVAR: 'admin.aprovacoes.aprovar',

  ADMIN_USUARIOS_VER: 'admin.usuarios.ver',
  ADMIN_USUARIOS_EDITAR: 'admin.usuarios.editar',

  ADMIN_PERFIS_VER: 'admin.perfis.ver',
  ADMIN_PERFIS_CRIAR: 'admin.perfis.criar',
  ADMIN_PERFIS_EDITAR: 'admin.perfis.editar',
  ADMIN_PERFIS_EXCLUIR: 'admin.perfis.excluir',

  ADMIN_CHAVES_PIX_VER: 'admin.chaves_pix.ver',
  ADMIN_CHAVES_PIX_APROVAR: 'admin.chaves_pix.aprovar',

  ADMIN_MED_VER: 'admin.med.ver',
  ADMIN_MED_DECIDIR: 'admin.med.decidir',

  ADMIN_TESOURARIA_VER: 'admin.tesouraria.ver',
  ADMIN_TESOURARIA_EDITAR: 'admin.tesouraria.editar',
  ADMIN_TESOURARIA_EXECUTAR: 'admin.tesouraria.executar',

  /**
   * Carteiras dos clientes (`saldos_usuarios`) — dinheiro DO LOJISTA. Separado
   * de `admin.tesouraria`, que é o saldo da VPay nas adquirentes: são caixas
   * diferentes e nem todo perfil que acompanha um precisa ver o outro.
   */
  ADMIN_CARTEIRAS_VER: 'admin.carteiras.ver',

  ADMIN_RELATORIOS_VER: 'admin.relatorios.ver',

  ADMIN_ADQUIRENTES_VER: 'admin.adquirentes.ver',
  ADMIN_ADQUIRENTES_CRIAR: 'admin.adquirentes.criar',
  ADMIN_ADQUIRENTES_EDITAR: 'admin.adquirentes.editar',

  ADMIN_CONTINGENCIA_VER: 'admin.contingencia.ver',
  ADMIN_CONTINGENCIA_EDITAR: 'admin.contingencia.editar',

  ADMIN_FILAS_VER: 'admin.filas.ver',
  ADMIN_FILAS_EXECUTAR: 'admin.filas.executar',

  ADMIN_AUDITORIA_VER: 'admin.auditoria.ver',

  /**
   * Escopo de leitura global: enxergar dados de QUALQUER cliente, e não
   * apenas os próprios. É o que separa "Financeiro somente leitura da operação
   * inteira" de "cliente que só vê a própria conta". Sem isto, toda listagem
   * volta filtrada pelo dono, mesmo para quem tem `*.ver`.
   */
  ESCOPO_GLOBAL: 'escopo.global',
} as const;

export type CodigoPermissao = (typeof PERMISSOES)[keyof typeof PERMISSOES];

export type AcaoCatalogo = {
  acao: Acao;
  codigo: CodigoPermissao;
  descricao: string;
};

export type RecursoCatalogo = {
  /** Prefixo do código da permissão. */
  chave: string;
  rotulo: string;
  grupo: string;
  /** Rotas do painel cobertas por este recurso (usado na guarda de página). */
  telas: string[];
  acoes: AcaoCatalogo[];
};

/**
 * Catálogo completo. A ordem aqui é a ordem exibida na matriz do painel.
 */
export const CATALOGO_PERMISSOES: RecursoCatalogo[] = [
  {
    chave: 'dashboard',
    rotulo: 'Dashboard',
    grupo: 'Operação',
    telas: ['/dashboard'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.DASHBOARD_VER,
        descricao: 'Abrir o dashboard e ver os indicadores',
      },
    ],
  },
  {
    chave: 'transacoes',
    rotulo: 'Transações',
    grupo: 'Operação',
    telas: ['/transacoes'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.TRANSACOES_VER,
        descricao: 'Listar e consultar transações',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.TRANSACOES_CRIAR,
        descricao: 'Gerar depósitos e solicitar saques pelo painel',
      },
    ],
  },
  {
    chave: 'adquirentes',
    rotulo: 'Adquirentes',
    grupo: 'Conta',
    telas: ['/adquirentes'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADQUIRENTES_VER,
        descricao: 'Ver as adquirentes liberadas para a conta',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADQUIRENTES_EDITAR,
        descricao: 'Escolher a adquirente de PIX in da conta',
      },
    ],
  },
  {
    chave: 'chaves_api',
    rotulo: 'Chaves de API',
    grupo: 'Desenvolvedores',
    telas: ['/desenvolvedores/chaves', '/desenvolvedores/integracoes'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.CHAVES_API_VER,
        descricao: 'Listar credenciais de API da conta',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.CHAVES_API_CRIAR,
        descricao: 'Emitir nova credencial de API',
      },
      {
        acao: ACOES.EXCLUIR,
        codigo: PERMISSOES.CHAVES_API_EXCLUIR,
        descricao: 'Revogar credencial de API',
      },
    ],
  },
  {
    chave: 'webhooks',
    rotulo: 'Webhooks',
    grupo: 'Desenvolvedores',
    telas: ['/desenvolvedores/webhooks'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.WEBHOOKS_VER,
        descricao: 'Listar webhooks cadastrados',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.WEBHOOKS_CRIAR,
        descricao: 'Cadastrar webhook',
      },
      {
        acao: ACOES.EXCLUIR,
        codigo: PERMISSOES.WEBHOOKS_EXCLUIR,
        descricao: 'Desativar webhook',
      },
    ],
  },
  {
    chave: 'chaves_pix',
    rotulo: 'Chaves PIX da conta',
    grupo: 'Desenvolvedores',
    telas: ['/configuracoes/chaves-pix'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.CHAVES_PIX_VER,
        descricao: 'Listar chaves PIX de recebimento da conta',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.CHAVES_PIX_CRIAR,
        descricao: 'Cadastrar chave PIX (entra pendente de aprovação)',
      },
      {
        acao: ACOES.EXCLUIR,
        codigo: PERMISSOES.CHAVES_PIX_EXCLUIR,
        descricao: 'Remover chave PIX da conta',
      },
    ],
  },
  {
    chave: 'admin.aprovacoes',
    rotulo: 'Aprovações de cadastro',
    grupo: 'Administração',
    telas: ['/admin/aprovacoes'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_APROVACOES_VER,
        descricao: 'Ver a fila de cadastros e os documentos enviados',
      },
      {
        acao: ACOES.APROVAR,
        codigo: PERMISSOES.ADMIN_APROVACOES_APROVAR,
        descricao: 'Validar documento, aprovar e reprovar cadastro',
      },
    ],
  },
  {
    chave: 'admin.usuarios',
    rotulo: 'Usuários',
    grupo: 'Administração',
    telas: ['/admin/usuarios'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_USUARIOS_VER,
        descricao: 'Listar usuários e abrir o detalhe',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADMIN_USUARIOS_EDITAR,
        descricao: 'Mudar situação, taxas, adquirente e perfis do usuário',
      },
    ],
  },
  {
    chave: 'admin.perfis',
    rotulo: 'Perfis de acesso',
    grupo: 'Administração',
    telas: ['/admin/perfis'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_PERFIS_VER,
        descricao: 'Listar perfis e ver as permissões de cada um',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.ADMIN_PERFIS_CRIAR,
        descricao: 'Criar perfil de acesso',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADMIN_PERFIS_EDITAR,
        descricao: 'Editar permissões, descrição e situação do perfil',
      },
      {
        acao: ACOES.EXCLUIR,
        codigo: PERMISSOES.ADMIN_PERFIS_EXCLUIR,
        descricao: 'Excluir perfil sem usuários vinculados',
      },
    ],
  },
  {
    chave: 'admin.chaves_pix',
    rotulo: 'Chaves PIX (aprovação)',
    grupo: 'Administração',
    telas: ['/admin/chaves-pix'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_CHAVES_PIX_VER,
        descricao: 'Ver a fila de chaves PIX pendentes',
      },
      {
        acao: ACOES.APROVAR,
        codigo: PERMISSOES.ADMIN_CHAVES_PIX_APROVAR,
        descricao: 'Aprovar ou recusar chave PIX de saque',
      },
    ],
  },
  {
    chave: 'admin.med',
    rotulo: 'MED',
    grupo: 'Administração',
    telas: ['/admin/med'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_MED_VER,
        descricao: 'Listar e consultar casos MED',
      },
      {
        acao: ACOES.DECIDIR,
        codigo: PERMISSOES.ADMIN_MED_DECIDIR,
        descricao: 'Aceitar ou recusar caso MED (liquida o dinheiro)',
      },
    ],
  },
  {
    chave: 'admin.tesouraria',
    rotulo: 'Saldos Adquirentes',
    grupo: 'Administração',
    telas: ['/admin/saldos'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_TESOURARIA_VER,
        descricao: 'Ver saldos nas adquirentes, gatilhos e execuções',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADMIN_TESOURARIA_EDITAR,
        descricao: 'Criar e editar gatilhos de saque automático',
      },
      {
        acao: ACOES.EXECUTAR,
        codigo: PERMISSOES.ADMIN_TESOURARIA_EXECUTAR,
        descricao: 'Disparar gatilho e forçar atualização de saldos',
      },
    ],
  },
  {
    chave: 'admin.carteiras',
    rotulo: 'Carteiras dos clientes',
    grupo: 'Administração',
    telas: ['/admin/carteiras'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_CARTEIRAS_VER,
        descricao:
          'Ver o saldo dos clientes (disponível, a liberar, reservado e bloqueado no MED)',
      },
    ],
  },
  {
    chave: 'admin.relatorios',
    rotulo: 'Relatórios',
    grupo: 'Administração',
    telas: [
      '/admin/relatorios/cash-in',
      '/admin/relatorios/cash-out',
      '/admin/relatorios/resultado',
    ],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_RELATORIOS_VER,
        descricao: 'Cash-in, cash-out, Lucro × Custo e dashboard administrativo',
      },
    ],
  },
  {
    chave: 'admin.adquirentes',
    rotulo: 'Adquirentes',
    grupo: 'Administração',
    telas: ['/admin/adquirentes'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_ADQUIRENTES_VER,
        descricao: 'Listar adquirentes, contas, custos e taxa padrão',
      },
      {
        acao: ACOES.CRIAR,
        codigo: PERMISSOES.ADMIN_ADQUIRENTES_CRIAR,
        descricao: 'Cadastrar adquirente',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADMIN_ADQUIRENTES_EDITAR,
        descricao: 'Editar adquirente, custo, taxa padrão e roteamento em massa',
      },
    ],
  },
  {
    chave: 'admin.contingencia',
    rotulo: 'Contingência de adquirentes',
    grupo: 'Administração',
    telas: ['/admin/contingencia'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_CONTINGENCIA_VER,
        descricao:
          'Ver a cadeia de contingência e o monitoramento de falhas das adquirentes',
      },
      {
        acao: ACOES.EDITAR,
        codigo: PERMISSOES.ADMIN_CONTINGENCIA_EDITAR,
        descricao: 'Definir a ordem das adquirentes de contingência',
      },
    ],
  },
  {
    chave: 'admin.filas',
    rotulo: 'Filas',
    grupo: 'Administração',
    telas: ['/admin/filas'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_FILAS_VER,
        descricao: 'Abrir o Bull Board e ver o estado das filas',
      },
      {
        acao: ACOES.EXECUTAR,
        codigo: PERMISSOES.ADMIN_FILAS_EXECUTAR,
        descricao: 'Reenviar callback ao lojista e reprocessar job',
      },
    ],
  },
  {
    chave: 'admin.auditoria',
    rotulo: 'Auditoria',
    grupo: 'Administração',
    telas: ['/admin/auditoria'],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ADMIN_AUDITORIA_VER,
        descricao: 'Consultar registros de auditoria e acessos',
      },
    ],
  },
  {
    chave: 'escopo',
    rotulo: 'Escopo global',
    grupo: 'Administração',
    telas: [],
    acoes: [
      {
        acao: ACOES.VER,
        codigo: PERMISSOES.ESCOPO_GLOBAL,
        descricao:
          'Enxergar dados de todos os clientes, e não apenas os próprios',
      },
    ],
  },
];

/** Todos os códigos do catálogo, na ordem de exibição. */
export const TODAS_PERMISSOES: CodigoPermissao[] = CATALOGO_PERMISSOES.flatMap(
  (r) => r.acoes.map((a) => a.codigo),
);

const DESCRICAO_POR_CODIGO = new Map<string, string>(
  CATALOGO_PERMISSOES.flatMap((r) =>
    r.acoes.map((a) => [a.codigo, `${r.rotulo}: ${a.descricao}`] as const),
  ),
);

export function descricaoPermissao(codigo: string): string {
  return DESCRICAO_POR_CODIGO.get(codigo) ?? codigo;
}

export function permissaoExiste(codigo: string): codigo is CodigoPermissao {
  return DESCRICAO_POR_CODIGO.has(codigo);
}

/** Recurso responsável por uma rota do painel (usado na guarda de página). */
export function permissaoDaTela(rota: string): CodigoPermissao | null {
  let melhor: { tela: string; codigo: CodigoPermissao } | null = null;
  for (const recurso of CATALOGO_PERMISSOES) {
    const ver = recurso.acoes.find((a) => a.acao === ACOES.VER);
    if (!ver) continue;
    for (const tela of recurso.telas) {
      if (rota !== tela && !rota.startsWith(tela + '/')) continue;
      // Rota mais específica ganha: /admin/relatorios/cash-in antes de /admin.
      if (!melhor || tela.length > melhor.tela.length) {
        melhor = { tela, codigo: ver.codigo };
      }
    }
  }
  return melhor?.codigo ?? null;
}

/**
 * Perfis que o seed cria e que o admin NÃO pode excluir nem renomear.
 * ADMINISTRADOR é o dono do sistema (recebe todas as permissões implicitamente);
 * CLIENTE é o perfil atribuído automaticamente a todo cadastro novo
 * (`auth.controller` vincula por nome), então sumir com ele quebra o cadastro.
 */
export const PERFIS_SISTEMA: string[] = ['ADMINISTRADOR', 'CLIENTE'];

/** Permissões do perfil CLIENTE recém-cadastrado. */
export const PERMISSOES_PADRAO_CLIENTE: CodigoPermissao[] = [
  PERMISSOES.DASHBOARD_VER,
  PERMISSOES.TRANSACOES_VER,
  PERMISSOES.TRANSACOES_CRIAR,
  PERMISSOES.ADQUIRENTES_VER,
  PERMISSOES.ADQUIRENTES_EDITAR,
  PERMISSOES.CHAVES_API_VER,
  PERMISSOES.CHAVES_API_CRIAR,
  PERMISSOES.CHAVES_API_EXCLUIR,
  PERMISSOES.WEBHOOKS_VER,
  PERMISSOES.WEBHOOKS_CRIAR,
  PERMISSOES.WEBHOOKS_EXCLUIR,
  PERMISSOES.CHAVES_PIX_VER,
  PERMISSOES.CHAVES_PIX_CRIAR,
  PERMISSOES.CHAVES_PIX_EXCLUIR,
];

/** Sugestões de perfil interno criadas pelo seed (o admin pode editar à vontade). */
export const PERMISSOES_PADRAO_FINANCEIRO: CodigoPermissao[] = [
  PERMISSOES.ESCOPO_GLOBAL,
  PERMISSOES.DASHBOARD_VER,
  PERMISSOES.TRANSACOES_VER,
  PERMISSOES.ADMIN_RELATORIOS_VER,
  PERMISSOES.ADMIN_TESOURARIA_VER,
  PERMISSOES.ADMIN_CARTEIRAS_VER,
  PERMISSOES.ADMIN_AUDITORIA_VER,
];

export const PERMISSOES_PADRAO_ANALISTA_MED: CodigoPermissao[] = [
  PERMISSOES.ESCOPO_GLOBAL,
  PERMISSOES.DASHBOARD_VER,
  PERMISSOES.TRANSACOES_VER,
  PERMISSOES.ADMIN_MED_VER,
  PERMISSOES.ADMIN_MED_DECIDIR,
];

export const PERMISSOES_PADRAO_FUNCIONARIO: CodigoPermissao[] = [
  PERMISSOES.ESCOPO_GLOBAL,
  PERMISSOES.DASHBOARD_VER,
  PERMISSOES.TRANSACOES_VER,
  PERMISSOES.ADMIN_APROVACOES_VER,
  PERMISSOES.ADMIN_USUARIOS_VER,
];
