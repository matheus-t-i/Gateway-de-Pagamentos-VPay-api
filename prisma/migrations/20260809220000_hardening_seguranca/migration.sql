-- Hardening de segurança (auditoria P0/P1):
-- limites diários/velocity de saque, bloqueio por abuso, HMAC B2B,
-- auditoria APPEND-ONLY.

-- ── Limites e antifraude de saque (config do cliente) ──────────────────────
ALTER TABLE "configuracoes_pix_usuarios"
  ADD COLUMN IF NOT EXISTS "limite_diario_pix_saida" DECIMAL(19,2),
  ADD COLUMN IF NOT EXISTS "max_saques_por_hora" INTEGER,
  ADD COLUMN IF NOT EXISTS "saque_bloqueado_por_abuso" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "saque_bloqueado_por_abuso_em" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "saque_bloqueado_por_abuso_motivo" TEXT;

ALTER TABLE "configuracoes_padrao_pix_usuarios"
  ADD COLUMN IF NOT EXISTS "limite_diario_pix_saida" DECIMAL(19,2),
  ADD COLUMN IF NOT EXISTS "max_saques_por_hora" INTEGER;

-- ── HMAC de request B2B (segredo cifrado para verificar assinatura) ─────
ALTER TABLE "credenciais_api"
  ADD COLUMN IF NOT EXISTS "exigir_assinatura_hmac" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "segredo_hmac_criptografado" TEXT,
  ADD COLUMN IF NOT EXISTS "segredo_hmac_anterior_criptografado" TEXT;

-- ── Auditoria APPEND-ONLY ───────────────────────────────────────────────
-- Trigger impede UPDATE/DELETE independentemente do papel da app.
CREATE OR REPLACE FUNCTION impede_mutacao_auditoria()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'registros_auditoria é APPEND-ONLY (UPDATE/DELETE proibidos)';
END;
$$;

DROP TRIGGER IF EXISTS trg_auditoria_append_only ON "registros_auditoria";
CREATE TRIGGER trg_auditoria_append_only
  BEFORE UPDATE OR DELETE ON "registros_auditoria"
  FOR EACH ROW
  EXECUTE PROCEDURE impede_mutacao_auditoria();
