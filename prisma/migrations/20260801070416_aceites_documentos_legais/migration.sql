-- DropForeignKey
ALTER TABLE "credenciais_api" DROP CONSTRAINT "credenciais_api_empresa_usuario_fk";

-- CreateTable
CREATE TABLE "aceites_documentos_legais" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "documento" VARCHAR(80) NOT NULL,
    "versao" VARCHAR(20) NOT NULL,
    "endereco_ip" VARCHAR(45),
    "agente_usuario" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "aceito_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aceites_documentos_legais_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aceites_documentos_legais_usuario_id_idx" ON "aceites_documentos_legais"("usuario_id");

-- AddForeignKey
ALTER TABLE "aceites_documentos_legais" ADD CONSTRAINT "aceites_documentos_legais_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
