-- Remove 'ANALISE_MANUAL' do enum ModoTratamentoMed.
--
-- MED SEMPRE desconta saldo: BLOQUEAR_SALDO move disponivel->bloqueado e manda
-- o caso para a fila do admin; DEBITAR_IMEDIATAMENTE tira na hora. Nao existe
-- modo que so sinalize. O valor era residuo de schema: nenhum ramo de
-- MedService casava com ele, entao uma conta assim receberia MED sem que o
-- dinheiro fosse tocado.
--
-- Conferido antes de aplicar: 0 linhas em configuracoes_pix_usuarios,
-- configuracoes_padrao_pix_usuarios e casos_med usavam o valor.
--
-- Postgres nao tem ALTER TYPE ... DROP VALUE: o tipo e recriado e as colunas
-- sao convertidas.
-- AlterEnum
BEGIN;
CREATE TYPE "ModoTratamentoMed_new" AS ENUM ('BLOQUEAR_SALDO', 'DEBITAR_IMEDIATAMENTE');
ALTER TABLE "public"."configuracoes_padrao_pix_usuarios" ALTER COLUMN "modo_tratamento_med" DROP DEFAULT;
ALTER TABLE "public"."configuracoes_pix_usuarios" ALTER COLUMN "modo_tratamento_med" DROP DEFAULT;
ALTER TABLE "configuracoes_padrao_pix_usuarios" ALTER COLUMN "modo_tratamento_med" TYPE "ModoTratamentoMed_new" USING ("modo_tratamento_med"::text::"ModoTratamentoMed_new");
ALTER TABLE "configuracoes_pix_usuarios" ALTER COLUMN "modo_tratamento_med" TYPE "ModoTratamentoMed_new" USING ("modo_tratamento_med"::text::"ModoTratamentoMed_new");
ALTER TABLE "casos_med" ALTER COLUMN "modo_tratamento_aplicado" TYPE "ModoTratamentoMed_new" USING ("modo_tratamento_aplicado"::text::"ModoTratamentoMed_new");
ALTER TYPE "ModoTratamentoMed" RENAME TO "ModoTratamentoMed_old";
ALTER TYPE "ModoTratamentoMed_new" RENAME TO "ModoTratamentoMed";
DROP TYPE "public"."ModoTratamentoMed_old";
ALTER TABLE "configuracoes_padrao_pix_usuarios" ALTER COLUMN "modo_tratamento_med" SET DEFAULT 'BLOQUEAR_SALDO';
ALTER TABLE "configuracoes_pix_usuarios" ALTER COLUMN "modo_tratamento_med" SET DEFAULT 'BLOQUEAR_SALDO';
COMMIT;
