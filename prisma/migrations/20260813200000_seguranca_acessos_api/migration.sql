-- Trilha das rotas sensíveis (/v1/*) para a tela /admin/seguranca.
--
-- A tabela `registros_acesso_api` já existia no schema, mas NADA escrevia nela:
-- foi desenhada e nunca ligada. Estas colunas são o que faltava para responder
-- as perguntas de segurança — quem tentou, de onde, e por que foi recusado.

ALTER TABLE "registros_acesso_api"
  -- Chave PÚBLICA apresentada na tentativa. Sem ela, um 401 (onde não há
  -- credencial resolvida) seria um registro anônimo, inútil para investigar.
  ADD COLUMN IF NOT EXISTS "chave_publica"  VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "agente_usuario" TEXT,
  -- Redundante com status_http < 400, porém indexável: a tela abre em "só
  -- falhas" e comparação não usaria índice.
  ADD COLUMN IF NOT EXISTS "sucesso"        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "codigo_erro"    VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "mensagem_erro"  TEXT;

-- Linha nascida antes desta migration não tem `sucesso` correto (o DEFAULT
-- marcou tudo como sucesso). Como a tabela nunca foi escrita, isto é apenas
-- garantia caso exista algum registro de teste.
UPDATE "registros_acesso_api" SET "sucesso" = ("status_http" < 400);

-- Um índice por eixo de investigação da tela.
CREATE INDEX IF NOT EXISTS "registros_acesso_api_criado_em_idx"
  ON "registros_acesso_api" ("criado_em");
CREATE INDEX IF NOT EXISTS "registros_acesso_api_sucesso_criado_em_idx"
  ON "registros_acesso_api" ("sucesso", "criado_em");
CREATE INDEX IF NOT EXISTS "registros_acesso_api_endereco_ip_criado_em_idx"
  ON "registros_acesso_api" ("endereco_ip", "criado_em");
CREATE INDEX IF NOT EXISTS "registros_acesso_api_credencial_api_id_criado_em_idx"
  ON "registros_acesso_api" ("credencial_api_id", "criado_em");
CREATE INDEX IF NOT EXISTS "registros_acesso_api_usuario_id_criado_em_idx"
  ON "registros_acesso_api" ("usuario_id", "criado_em");

-- FK do usuário: a coluna existia sem vínculo declarado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'registros_acesso_api_usuario_id_fkey'
  ) THEN
    ALTER TABLE "registros_acesso_api"
      ADD CONSTRAINT "registros_acesso_api_usuario_id_fkey"
      FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
