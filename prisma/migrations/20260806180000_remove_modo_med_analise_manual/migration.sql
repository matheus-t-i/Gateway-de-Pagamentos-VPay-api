-- Remove ModoTratamentoMed.ANALISE_MANUAL — versão IDEMPOTENTE.
--
-- Esta migration é duplicata de 20260806180000_med_sem_analise_manual (mesmo
-- timestamp; a outra roda primeiro na ordem alfabética e já remove o rótulo).
-- A versão original falhava SEMPRE que rodava depois dela: o WHERE comparava a
-- coluna com o literal 'ANALISE_MANUAL', que o Postgres recusa no parse quando
-- o rótulo já saiu do enum. Nunca aplicou em ambiente nenhum por isso.
--
-- Reescrita como no-op guardado: só faz o trabalho se ANALISE_MANUAL ainda
-- existir no enum (banco que por acaso não tenha passado pela outra), e as
-- comparações usam ::text para nunca dependerem do rótulo existir.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'ModoTratamentoMed' AND e.enumlabel = 'ANALISE_MANUAL'
  ) THEN
    UPDATE "configuracoes_pix_usuarios"
    SET "modo_tratamento_med" = 'BLOQUEAR_SALDO'
    WHERE "modo_tratamento_med"::text = 'ANALISE_MANUAL';

    UPDATE "configuracoes_padrao_pix_usuarios"
    SET "modo_tratamento_med" = 'BLOQUEAR_SALDO'
    WHERE "modo_tratamento_med"::text = 'ANALISE_MANUAL';

    UPDATE "casos_med"
    SET "modo_tratamento_aplicado" = 'BLOQUEAR_SALDO'
    WHERE "modo_tratamento_aplicado"::text = 'ANALISE_MANUAL';

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
  END IF;
END $$;
