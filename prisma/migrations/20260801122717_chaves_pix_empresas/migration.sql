-- CreateEnum
CREATE TYPE "SituacaoChavePix" AS ENUM ('PENDENTE', 'APROVADA', 'REPROVADA', 'INATIVA');

-- CreateEnum
CREATE TYPE "TipoChavePix" AS ENUM ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA');

-- DropForeignKey
ALTER TABLE "credenciais_api" DROP CONSTRAINT "credenciais_api_empresa_usuario_fk";

-- CreateTable
CREATE TABLE "chaves_pix_empresas" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "empresa_id" BIGINT NOT NULL,
    "apelido" VARCHAR(100),
    "chave" VARCHAR(255) NOT NULL,
    "tipo_chave" "TipoChavePix" NOT NULL,
    "nome_titular" VARCHAR(255),
    "documento_titular" VARCHAR(14),
    "situacao" "SituacaoChavePix" NOT NULL DEFAULT 'PENDENTE',
    "motivo_reprovacao" TEXT,
    "aprovada_por_usuario_id" BIGINT,
    "aprovada_em" TIMESTAMPTZ,
    "criado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chaves_pix_empresas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chaves_pix_empresas_id_publico_key" ON "chaves_pix_empresas"("id_publico");

-- CreateIndex
CREATE INDEX "chaves_pix_empresas_empresa_id_situacao_idx" ON "chaves_pix_empresas"("empresa_id", "situacao");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_pix_empresas_empresa_id_chave_key" ON "chaves_pix_empresas"("empresa_id", "chave");

-- AddForeignKey
ALTER TABLE "chaves_pix_empresas" ADD CONSTRAINT "chaves_pix_empresas_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_pix_empresas" ADD CONSTRAINT "chaves_pix_empresas_aprovada_por_usuario_id_fkey" FOREIGN KEY ("aprovada_por_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
