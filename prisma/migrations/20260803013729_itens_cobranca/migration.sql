-- AlterTable
ALTER TABLE "transacoes_pix" ADD COLUMN     "endereco_pagador" JSONB;

-- CreateTable
CREATE TABLE "itens_cobranca" (
    "id" BIGSERIAL NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "titulo" VARCHAR(255) NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "valor_unitario" DECIMAL(19,2) NOT NULL,
    "valor_total" DECIMAL(19,2) NOT NULL,
    "tangivel" BOOLEAN NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itens_cobranca_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "itens_cobranca_transacao_id_idx" ON "itens_cobranca"("transacao_id");

-- AddForeignKey
ALTER TABLE "itens_cobranca" ADD CONSTRAINT "itens_cobranca_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- INVARIANTES DOS ITENS DA COBRANÇA
-- Quantidade zero/negativa ou preço negativo viraria "venda" com total inválido
-- e contaminaria o relatório de cash-in.
-- ============================================================================
ALTER TABLE itens_cobranca
  DROP CONSTRAINT IF EXISTS itens_cobranca_valores_coerentes_chk;
ALTER TABLE itens_cobranca
  ADD CONSTRAINT itens_cobranca_valores_coerentes_chk
  CHECK (
    quantidade > 0
    AND valor_unitario >= 0
    AND valor_total >= 0
  );
