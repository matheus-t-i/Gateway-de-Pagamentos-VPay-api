-- CreateEnum
CREATE TYPE "TipoIntegracao" AS ENUM ('UTMIFY');

-- AlterTable
ALTER TABLE "transacoes" ADD COLUMN     "parametros_rastreio" JSONB;

-- CreateTable
CREATE TABLE "integracoes_usuario" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "tipo" "TipoIntegracao" NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "credenciais_criptografadas" TEXT NOT NULL,
    "eventos" JSONB NOT NULL DEFAULT '[]',
    "modo_teste" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "integracoes_usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envios_integracao" (
    "id" BIGSERIAL NOT NULL,
    "integracao_id" BIGINT NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "status_remoto" VARCHAR(30) NOT NULL,
    "situacao" VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
    "numero_tentativa" INTEGER NOT NULL DEFAULT 0,
    "status_http" INTEGER,
    "corpo_resposta" TEXT,
    "mensagem_erro" TEXT,
    "latencia_ms" INTEGER,
    "enviado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "envios_integracao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integracoes_usuario_id_publico_key" ON "integracoes_usuario"("id_publico");

-- CreateIndex
CREATE INDEX "integracoes_usuario_usuario_id_idx" ON "integracoes_usuario"("usuario_id");

-- CreateIndex
CREATE INDEX "integracoes_usuario_usuario_id_ativo_idx" ON "integracoes_usuario"("usuario_id", "ativo");

-- CreateIndex
CREATE INDEX "envios_integracao_integracao_id_criado_em_idx" ON "envios_integracao"("integracao_id", "criado_em");

-- CreateIndex
CREATE INDEX "envios_integracao_situacao_idx" ON "envios_integracao"("situacao");

-- CreateIndex
CREATE UNIQUE INDEX "envios_integracao_integracao_id_transacao_id_status_remoto_key" ON "envios_integracao"("integracao_id", "transacao_id", "status_remoto");

-- AddForeignKey
ALTER TABLE "integracoes_usuario" ADD CONSTRAINT "integracoes_usuario_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envios_integracao" ADD CONSTRAINT "envios_integracao_integracao_id_fkey" FOREIGN KEY ("integracao_id") REFERENCES "integracoes_usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envios_integracao" ADD CONSTRAINT "envios_integracao_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
