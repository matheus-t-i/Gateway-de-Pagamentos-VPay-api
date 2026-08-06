-- AlterEnum
ALTER TYPE "SituacaoChavePix" ADD VALUE 'REVOGADA';

-- CreateTable
CREATE TABLE "historicos_chave_pix" (
    "id" BIGSERIAL NOT NULL,
    "chave_pix_id" BIGINT NOT NULL,
    "situacao_anterior" "SituacaoChavePix" NOT NULL,
    "nova_situacao" "SituacaoChavePix" NOT NULL,
    "motivo" VARCHAR(500),
    "usuario_ator_id" BIGINT,
    "origem" VARCHAR(20) NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historicos_chave_pix_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historicos_chave_pix_chave_pix_id_criado_em_idx" ON "historicos_chave_pix"("chave_pix_id", "criado_em");

-- CreateIndex
CREATE INDEX "chaves_pix_usuarios_chave_idx" ON "chaves_pix_usuarios"("chave");

-- AddForeignKey
ALTER TABLE "historicos_chave_pix" ADD CONSTRAINT "historicos_chave_pix_chave_pix_id_fkey" FOREIGN KEY ("chave_pix_id") REFERENCES "chaves_pix_usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historicos_chave_pix" ADD CONSTRAINT "historicos_chave_pix_usuario_ator_id_fkey" FOREIGN KEY ("usuario_ator_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
