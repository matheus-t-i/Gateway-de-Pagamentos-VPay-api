-- AlterTable
ALTER TABLE "contas_provedor" ADD COLUMN "percentual_retencao_metodo" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "configuracoes_pix_usuarios" ADD COLUMN "retencao_metodo_ativo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "configuracoes_pix_usuarios" ADD COLUMN "percentual_retencao_metodo" DECIMAL(7,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transacoes" ADD COLUMN "retida_metodo" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "transacoes_retida_metodo_idx" ON "transacoes"("retida_metodo");

-- CreateTable
CREATE TABLE "parametros_retencao_metodo" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "texto_excecao" VARCHAR(80) NOT NULL DEFAULT 'teste',
    "valor_minimo_retencao" DECIMAL(19,2) NOT NULL DEFAULT 16,
    "faturamento_minimo_dia" DECIMAL(19,2) NOT NULL DEFAULT 200,
    "offset_min" INTEGER NOT NULL DEFAULT 3,
    "offset_max" INTEGER NOT NULL DEFAULT 5,
    "percentual_fallback" DECIMAL(7,4) NOT NULL DEFAULT 13,
    "offset_atual" INTEGER NOT NULL DEFAULT 0,
    "data_referencia_dia" DATE NOT NULL DEFAULT '1970-01-01'::date,
    "faturamento_pago_dia" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_retido_dia" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMPTZ NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parametros_retencao_metodo_pkey" PRIMARY KEY ("id")
);

-- Seed singleton (id=1). atualizado_em exige valor na inserção.
INSERT INTO "parametros_retencao_metodo" ("id", "atualizado_em")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
