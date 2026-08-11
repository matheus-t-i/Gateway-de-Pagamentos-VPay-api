-- Restaura a flag de chave cadastrada na API (BAAS).
-- Default true = seguro: exige chave APROVADA também na API.
-- false = chave livre só via API + IP allowlist; painel continua sempre exigindo cadastrada.
ALTER TABLE "configuracoes_padrao_pix_usuarios"
  ADD COLUMN IF NOT EXISTS "exigir_chave_pix_cadastrada" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "configuracoes_pix_usuarios"
  ADD COLUMN IF NOT EXISTS "exigir_chave_pix_cadastrada" BOOLEAN NOT NULL DEFAULT true;
