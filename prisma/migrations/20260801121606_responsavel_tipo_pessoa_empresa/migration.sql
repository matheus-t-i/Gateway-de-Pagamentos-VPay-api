-- AlterTable
ALTER TABLE "empresas" ADD COLUMN     "tipo_pessoa" "TipoPessoa" NOT NULL DEFAULT 'PJ';

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "cpf_responsavel" VARCHAR(14),
ADD COLUMN     "nome_responsavel" VARCHAR(255);

-- ============================================================================
-- Backfill 1: responsável das contas existentes = o próprio titular.
-- ============================================================================
UPDATE usuarios
   SET cpf_responsavel = COALESCE(cpf_responsavel, cpf_cnpj),
       nome_responsavel = COALESCE(nome_responsavel, nome_razao_social)
 WHERE cpf_responsavel IS NULL OR nome_responsavel IS NULL;

-- ============================================================================
-- Backfill 2: tipo_pessoa das empresas existentes = o do proprietário.
-- ============================================================================
UPDATE empresas e
   SET tipo_pessoa = u.tipo_pessoa
  FROM usuarios u
 WHERE u.id = e.usuario_proprietario_id;

-- ============================================================================
-- Backfill 3: toda conta CLIENTE precisa de uma empresa (a 1ª é a própria
-- pessoa). Cria para quem ainda não tem. Exclui contas internas
-- (ADMINISTRADOR/FUNCIONARIO), que não operam e não devem gerar empresa
-- fantasma. id_publico e atualizado_em não têm DEFAULT no banco.
-- ============================================================================
INSERT INTO empresas (
  id_publico, usuario_proprietario_id, cnpj, tipo_pessoa, razao_social,
  nome_fantasia, email, telefone, situacao, metadados,
  criado_por_usuario_id, criado_em, atualizado_em
)
SELECT gen_random_uuid(), u.id, u.cpf_cnpj, u.tipo_pessoa, u.nome_razao_social,
       u.nome_fantasia, u.email, u.telefone,
       CASE WHEN u.situacao = 'ATIVO' THEN 'ATIVA'::"SituacaoEmpresa"
            ELSE 'PENDENTE'::"SituacaoEmpresa" END,
       '{}'::jsonb, u.id, now(), now()
  FROM usuarios u
 WHERE NOT EXISTS (SELECT 1 FROM empresas e WHERE e.usuario_proprietario_id = u.id)
   AND NOT EXISTS (
         SELECT 1 FROM usuarios_papeis up
           JOIN papeis p ON p.id = up.papel_id
          WHERE up.usuario_id = u.id
            AND p.nome IN ('ADMINISTRADOR', 'FUNCIONARIO'))
   AND NOT EXISTS (SELECT 1 FROM empresas e2 WHERE e2.cnpj = u.cpf_cnpj);

-- Empresas do backfill que nasceram ATIVA precisam de saldo (criado na ativação).
-- atualizado_em não tem DEFAULT no banco (vem do @updatedAt do Prisma).
INSERT INTO saldos_empresas (empresa_id, atualizado_em)
SELECT e.id, now() FROM empresas e
 WHERE e.situacao = 'ATIVA'
   AND NOT EXISTS (SELECT 1 FROM saldos_empresas s WHERE s.empresa_id = e.id);

-- Análise de cadastro para as empresas criadas no backfill.
INSERT INTO analises_cadastro_empresas (empresa_id, situacao, criado_em, atualizado_em)
SELECT e.id,
       CASE WHEN e.situacao = 'ATIVA' THEN 'APROVADA'::"SituacaoAnalise"
            ELSE 'PENDENTE'::"SituacaoAnalise" END,
       now(), now()
  FROM empresas e
 WHERE NOT EXISTS (
   SELECT 1 FROM analises_cadastro_empresas a WHERE a.empresa_id = e.id);

-- ============================================================================
-- Restaura a FK composta dropada pela migration 20260801070416: garante que a
-- credencial de API pertence ao MESMO usuário dono da empresa.
-- ============================================================================
ALTER TABLE credenciais_api
  DROP CONSTRAINT IF EXISTS credenciais_api_empresa_usuario_fk;
ALTER TABLE credenciais_api
  ADD CONSTRAINT credenciais_api_empresa_usuario_fk
  FOREIGN KEY (empresa_id, usuario_id)
  REFERENCES empresas (id, usuario_proprietario_id);
