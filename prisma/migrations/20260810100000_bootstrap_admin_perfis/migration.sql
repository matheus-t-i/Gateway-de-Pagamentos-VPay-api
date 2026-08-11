-- ============================================================================
-- Bootstrap de PRODUÇÃO: perfis ADMINISTRADOR/CLIENTE, catálogo de permissões
-- e a primeira conta de administrador.
--
-- POR QUE ISTO É UMA MIGRATION E NÃO O SEED
-- O `prisma/seed.ts` NÃO roda dentro da imagem de produção: ele é
-- `tsx prisma/seed.ts`, o `tsx` é devDependency e a imagem faz
-- `npm ci --omit=dev`; o `nest build` também não compila `prisma/seed.ts`.
-- Sem isto, um banco novo sobe sem perfis, sem permissões e sem NENHUM usuário
-- — ninguém consegue logar. A migration, sim, roda: o `preDeployCommand` do
-- render.yaml executa `prisma migrate deploy` com a CLI pinada da imagem.
--
-- IDEMPOTENTE de propósito. `migrate deploy` aplica uma vez por banco, mas este
-- arquivo também roda em bancos de desenvolvimento que JÁ foram semeados — e ali
-- os perfis e o catálogo já existem. Nada aqui pode estourar por duplicidade nem
-- sobrescrever o que o admin já configurou.
--
-- ESTE ARQUIVO É UM SNAPSHOT, NÃO UMA SINCRONIZAÇÃO. A fonte única do catálogo
-- continua sendo `src/shared/permissoes.ts` (o SQL abaixo foi GERADO a partir
-- dela, não digitado). Permissão nova entra pelo seed em dev; em produção, por
-- uma migration nova. Nunca editar a lista daqui à mão.
-- ============================================================================

-- ─── 1. Perfis ──────────────────────────────────────────────────────────────
-- Só os dois de sistema (`PERFIS_SISTEMA`): ADMINISTRADOR e CLIENTE. Os perfis
-- sugeridos que o seed de desenvolvimento cria (FINANCEIRO, ANALISTA_MED,
-- FUNCIONARIO) ficam de fora — quem quiser cria em /admin/perfis.
INSERT INTO papeis (nome, descricao, ativo, criado_em, atualizado_em)
VALUES
  ('ADMINISTRADOR', 'Administrador do sistema', TRUE, NOW(), NOW()),
  ('CLIENTE',       'Cliente do gateway',       TRUE, NOW(), NOW())
ON CONFLICT (nome) DO NOTHING;

-- ─── 2. Catálogo de permissões ──────────────────────────────────────────────
-- 53 permissões, geradas de `TODAS_PERMISSOES`. `ON CONFLICT DO NOTHING` para
-- não reescrever descrição que o seed já tenha ajustado.
INSERT INTO permissoes (codigo, descricao, criado_em)
SELECT v.codigo, v.descricao, NOW()
FROM (VALUES
  ('dashboard.ver', 'Dashboard: Abrir o dashboard e ver os indicadores'),
  ('faturamento.ver', 'Faturamento: Ver GMV acumulado e marcos de premiação'),
  ('transacoes.ver', 'Transações: Listar e consultar transações'),
  ('transacoes.criar', 'Transações: Gerar depósitos e solicitar saques pelo painel'),
  ('transacoes.executar', 'Transações: Reenviar o callback (webhook) de uma transação da conta'),
  ('adquirentes.ver', 'Adquirentes: Ver as adquirentes liberadas para a conta'),
  ('adquirentes.editar', 'Adquirentes: Escolher a adquirente de PIX in da conta'),
  ('chaves_api.ver', 'Chaves de API: Listar credenciais de API da conta'),
  ('chaves_api.criar', 'Chaves de API: Emitir nova credencial de API'),
  ('chaves_api.editar', 'Chaves de API: Alterar nome e IPs permitidos de uma credencial'),
  ('chaves_api.excluir', 'Chaves de API: Revogar credencial de API'),
  ('webhooks.ver', 'Webhooks: Listar webhooks cadastrados'),
  ('webhooks.criar', 'Webhooks: Cadastrar webhook'),
  ('webhooks.excluir', 'Webhooks: Desativar webhook'),
  ('integracoes.ver', 'Integrações: Listar os apps conectados e o histórico de envio'),
  ('integracoes.criar', 'Integrações: Conectar um app à conta'),
  ('integracoes.editar', 'Integrações: Editar credencial, eventos e situação da integração; reenviar pedido'),
  ('integracoes.excluir', 'Integrações: Desconectar app'),
  ('chaves_pix.ver', 'Chaves PIX da conta: Listar chaves PIX de recebimento da conta'),
  ('chaves_pix.criar', 'Chaves PIX da conta: Cadastrar chave PIX (entra pendente de aprovação)'),
  ('chaves_pix.excluir', 'Chaves PIX da conta: Remover chave PIX da conta'),
  ('admin.aprovacoes.ver', 'Aprovações de cadastro: Ver a fila de cadastros e os documentos enviados'),
  ('admin.aprovacoes.aprovar', 'Aprovações de cadastro: Validar documento, aprovar e reprovar cadastro'),
  ('admin.usuarios.ver', 'Usuários: Listar usuários e abrir o detalhe'),
  ('admin.usuarios.editar', 'Usuários: Mudar situação, taxas, adquirente e perfis do usuário'),
  ('admin.perfis.ver', 'Perfis de acesso: Listar perfis e ver as permissões de cada um'),
  ('admin.perfis.criar', 'Perfis de acesso: Criar perfil de acesso'),
  ('admin.perfis.editar', 'Perfis de acesso: Editar permissões, descrição e situação do perfil'),
  ('admin.perfis.excluir', 'Perfis de acesso: Excluir perfil sem usuários vinculados'),
  ('admin.chaves_pix.ver', 'Chaves PIX (aprovação): Ver a fila de chaves PIX pendentes'),
  ('admin.chaves_pix.aprovar', 'Chaves PIX (aprovação): Aprovar ou recusar chave PIX de saque'),
  ('admin.med.ver', 'MED: Listar e consultar casos MED'),
  ('admin.med.decidir', 'MED: Aceitar ou recusar caso MED (liquida o dinheiro)'),
  ('admin.tesouraria.ver', 'Saldos Adquirentes: Ver saldos nas adquirentes, gatilhos e execuções'),
  ('admin.tesouraria.editar', 'Saldos Adquirentes: Criar e editar gatilhos de saque automático'),
  ('admin.tesouraria.executar', 'Saldos Adquirentes: Disparar gatilho e forçar atualização de saldos'),
  ('admin.carteiras.ver', 'Carteiras dos clientes: Ver o saldo dos clientes (disponível, a liberar, reservado e bloqueado no MED)'),
  ('admin.carteiras.executar', 'Carteiras dos clientes: Bloqueio administrativo de saldo: bloquear valor de cliente, liberar e debitar'),
  ('admin.relatorios.ver', 'Relatórios: Cash-in, cash-out, Lucro × Custo, Relatório Método e dashboard administrativo'),
  ('admin.relatorios.editar', 'Relatórios: Liberar venda retida pelo método de retenção no cash-in'),
  ('admin.adquirentes.ver', 'Adquirentes: Listar adquirentes, contas, custos e taxa padrão'),
  ('admin.adquirentes.criar', 'Adquirentes: Cadastrar adquirente'),
  ('admin.adquirentes.editar', 'Adquirentes: Editar adquirente, custo, taxa padrão e roteamento em massa'),
  ('admin.contingencia.ver', 'Contingência de adquirentes: Ver a cadeia de contingência e o monitoramento de falhas das adquirentes'),
  ('admin.contingencia.editar', 'Contingência de adquirentes: Definir a ordem das adquirentes de contingência'),
  ('admin.retencao.ver', 'Retenção (método): Ver parâmetros globais do método de retenção'),
  ('admin.retencao.editar', 'Retenção (método): Alterar parâmetros e percentuais por adquirente'),
  ('admin.med_automatico.ver', 'MED automático: Ver parâmetros globais do MED automático'),
  ('admin.med_automatico.editar', 'MED automático: Alterar offset, tolerância e contenção do MED automático'),
  ('admin.filas.ver', 'Filas: Abrir o Bull Board e ver o estado das filas'),
  ('admin.filas.executar', 'Filas: Reenviar callback ao lojista e reprocessar job'),
  ('admin.auditoria.ver', 'Auditoria: Consultar registros de auditoria e acessos'),
  ('escopo.global', 'Escopo global: Enxergar dados de todos os clientes, e não apenas os próprios')
) AS v(codigo, descricao)
ON CONFLICT (codigo) DO NOTHING;

-- ─── 3. Permissões do perfil CLIENTE ────────────────────────────────────────
-- Geradas de `PERMISSOES_PADRAO_CLIENTE`. O ADMINISTRADOR NÃO recebe linhas de
-- propósito: `permissoesEfetivas` (src/auth/permissoes.util.ts) devolve
-- TODAS_PERMISSOES para ele por CÓDIGO, antes de consultar o banco — é a trava
-- anti-lockout, e o painel recusa editar as permissões desse perfil. Linha aqui
-- seria estado morto que passa a impressão de ser a fonte da concessão.
INSERT INTO papeis_permissoes (papel_id, permissao_id, criado_em)
SELECT p.id, pm.id, NOW()
FROM papeis p
JOIN permissoes pm ON pm.codigo IN (
    'dashboard.ver',
    'faturamento.ver',
    'transacoes.ver',
    'transacoes.criar',
    'transacoes.executar',
    'adquirentes.ver',
    'adquirentes.editar',
    'chaves_api.ver',
    'chaves_api.criar',
    'chaves_api.editar',
    'chaves_api.excluir',
    'webhooks.ver',
    'webhooks.criar',
    'webhooks.excluir',
    'integracoes.ver',
    'integracoes.criar',
    'integracoes.editar',
    'integracoes.excluir',
    'chaves_pix.ver',
    'chaves_pix.criar',
    'chaves_pix.excluir'
)
WHERE p.nome = 'CLIENTE'
ON CONFLICT (papel_id, permissao_id) DO NOTHING;

-- ─── 4. Conta de administrador ──────────────────────────────────────────────
-- `forcar_troca_senha = TRUE` é o que torna a senha padrão SEGURA de versionar:
-- `AuthController.login` recusa emitir token com esse flag ligado e devolve
-- `proximoPasso: 'TROCAR_SENHA'` (mesma trava do reset feito por admin). Ou
-- seja, a senha abaixo só serve para DEFINIR outra — ela não vira, em hipótese
-- nenhuma, a senha operacional da conta. Sem isso, o hash versionado no git
-- daria acesso de administrador a quem lesse o repositório.
--
-- Hash argon2id de: VPay@Trocar2026
-- (senha conferida contra `violacoesSenha` e o hash contra `argon2.verify`)
DO $$
DECLARE
  v_usuario_id BIGINT;
  v_papel_id   BIGINT;
BEGIN
  SELECT id INTO v_usuario_id FROM usuarios WHERE email = 'festenmatheus.mh@gmail.com';

  IF v_usuario_id IS NULL THEN
    INSERT INTO usuarios (
      id_publico, tipo_pessoa, cpf_cnpj, nome_razao_social, email, senha_hash,
      situacao, conta_bloqueada, forcar_troca_senha, tema_preferido,
      totp_habilitado, metadados, ativado_em, criado_em, atualizado_em
    ) VALUES (
      gen_random_uuid(),
      'PF',
      -- Placeholder: o admin não é cliente e não passa por KYC. Não colide com
      -- o '00000000000' que o seed de desenvolvimento usa (cpf_cnpj é UNIQUE).
      '00000000001',
      'Administrador VPay',
      'festenmatheus.mh@gmail.com',
      '$argon2id$v=19$m=65536,t=3,p=4$wZE/YsWSyL0mZOUCE219Ug$nLBKWic1e8BC5oS7wLDc49Ih0pGOIZsNElSs1t1ULwg',
      'ATIVO',
      FALSE,
      TRUE,   -- forcar_troca_senha
      'PADRAO',
      FALSE,
      '{}'::jsonb,
      NOW(), NOW(), NOW()
    )
    RETURNING id INTO v_usuario_id;

    RAISE NOTICE 'Admin de bootstrap criado: festenmatheus.mh@gmail.com (troca de senha obrigatoria no 1o login)';
  ELSE
    -- Conta já existe: NÃO mexer em senha, situação nem flags. Reaplicar esta
    -- migration não pode derrubar a senha que o dono já trocou.
    RAISE NOTICE 'Admin ja existe (id=%), nada alterado', v_usuario_id;
  END IF;

  SELECT id INTO v_papel_id FROM papeis WHERE nome = 'ADMINISTRADOR';

  INSERT INTO usuarios_papeis (usuario_id, papel_id, criado_em)
  VALUES (v_usuario_id, v_papel_id, NOW())
  ON CONFLICT (usuario_id, papel_id) DO NOTHING;
END $$;
