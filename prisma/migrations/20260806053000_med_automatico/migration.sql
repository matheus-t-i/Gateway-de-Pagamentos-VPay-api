-- AlterTable
ALTER TABLE "configuracoes_pix_usuarios" ADD COLUMN "med_automatico_ativo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "configuracoes_pix_usuarios" ADD COLUMN "percentual_med_automatico" DECIMAL(7,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "transacoes" ADD COLUMN "med_automatico" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "transacoes_med_automatico_idx" ON "transacoes"("med_automatico");

-- CreateTable
CREATE TABLE "parametros_med_automatico" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ativo" BOOLEAN NOT NULL DEFAULT false,
    "offset_min" INTEGER NOT NULL DEFAULT 3,
    "offset_max" INTEGER NOT NULL DEFAULT 5,
    "tolerancia_valor" DECIMAL(19,2) NOT NULL DEFAULT 50,
    "contencao_ativa" BOOLEAN NOT NULL DEFAULT false,
    "percentual_contencao_dia" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMPTZ NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parametros_med_automatico_pkey" PRIMARY KEY ("id")
);

INSERT INTO "parametros_med_automatico" ("id", "atualizado_em")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- CreateTable
CREATE TABLE "estados_med_automatico_usuario" (
    "usuario_id" BIGINT NOT NULL,
    "offset_atual" INTEGER NOT NULL DEFAULT 0,
    "data_referencia_dia" DATE NOT NULL DEFAULT '1970-01-01'::date,
    "valor_med_aplicado_dia" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMPTZ NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estados_med_automatico_usuario_pkey" PRIMARY KEY ("usuario_id")
);

ALTER TABLE "estados_med_automatico_usuario"
ADD CONSTRAINT "estados_med_automatico_usuario_usuario_id_fkey"
FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
