-- Saque sempre exige chave PIX cadastrada e APROVADA (painel e API).
-- A flag configurável `exigir_chave_pix_cadastrada` deixa de existir.
ALTER TABLE "configuracoes_padrao_pix_usuarios" DROP COLUMN IF EXISTS "exigir_chave_pix_cadastrada";
ALTER TABLE "configuracoes_pix_usuarios" DROP COLUMN IF EXISTS "exigir_chave_pix_cadastrada";
