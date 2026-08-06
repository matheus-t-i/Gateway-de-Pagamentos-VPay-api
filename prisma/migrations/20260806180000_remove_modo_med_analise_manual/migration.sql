-- Remove ModoTratamentoMed.ANALISE_MANUAL
--
-- MED sempre desconta saldo: só restam BLOQUEAR_SALDO e DEBITAR_IMEDIATAMENTE.
-- Contas/casos que estavam em ANALISE_MANUAL passam a BLOQUEAR_SALDO (bloqueia
-- o que houver e vai para a fila de /admin/med) — nunca ficam "só sinalizando".
--
-- PostgreSQL não tem ALTER TYPE … DROP VALUE; recria o enum (padrão seguro).

UPDATE "configuracoes_pix_usuarios"
SET "modo_tratamento_med" = 'BLOQUEAR_SALDO'
WHERE "modo_tratamento_med" = 'ANALISE_MANUAL';

UPDATE "configuracoes_padrao_pix_usuarios"
SET "modo_tratamento_med" = 'BLOQUEAR_SALDO'
WHERE "modo_tratamento_med" = 'ANALISE_MANUAL';

UPDATE "casos_med"
SET "modo_tratamento_aplicado" = 'BLOQUEAR_SALDO'
WHERE "modo_tratamento_aplicado" = 'ANALISE_MANUAL';

CREATE TYPE "ModoTratamentoMed_novo" AS ENUM (
  'BLOQUEAR_SALDO',
  'DEBITAR_IMEDIATAMENTE'
);

ALTER TABLE "configuracoes_pix_usuarios"
  ALTER COLUMN "modo_tratamento_med" DROP DEFAULT,
  ALTER COLUMN "modo_tratamento_med" TYPE "ModoTratamentoMed_novo"
    USING ("modo_tratamento_med"::text::"ModoTratamentoMed_novo"),
  ALTER COLUMN "modo_tratamento_med" SET DEFAULT 'BLOQUEAR_SALDO'::"ModoTratamentoMed_novo";

ALTER TABLE "configuracoes_padrao_pix_usuarios"
  ALTER COLUMN "modo_tratamento_med" DROP DEFAULT,
  ALTER COLUMN "modo_tratamento_med" TYPE "ModoTratamentoMed_novo"
    USING ("modo_tratamento_med"::text::"ModoTratamentoMed_novo"),
  ALTER COLUMN "modo_tratamento_med" SET DEFAULT 'BLOQUEAR_SALDO'::"ModoTratamentoMed_novo";

ALTER TABLE "casos_med"
  ALTER COLUMN "modo_tratamento_aplicado" TYPE "ModoTratamentoMed_novo"
    USING ("modo_tratamento_aplicado"::text::"ModoTratamentoMed_novo");

DROP TYPE "ModoTratamentoMed";
ALTER TYPE "ModoTratamentoMed_novo" RENAME TO "ModoTratamentoMed";
