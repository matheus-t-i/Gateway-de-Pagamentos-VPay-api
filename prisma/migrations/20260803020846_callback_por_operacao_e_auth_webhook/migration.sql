-- DropForeignKey
ALTER TABLE "entregas_webhook" DROP CONSTRAINT "entregas_webhook_configuracao_webhook_id_fkey";

-- AlterTable
ALTER TABLE "configuracoes_webhook_empresa" ADD COLUMN     "nome_header_autenticacao" VARCHAR(100);

-- AlterTable
ALTER TABLE "entregas_webhook" ADD COLUMN     "url_destino" TEXT,
ALTER COLUMN "configuracao_webhook_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "transacoes" ADD COLUMN     "url_callback" TEXT;

-- AddForeignKey
ALTER TABLE "entregas_webhook" ADD CONSTRAINT "entregas_webhook_configuracao_webhook_id_fkey" FOREIGN KEY ("configuracao_webhook_id") REFERENCES "configuracoes_webhook_empresa"("id") ON DELETE SET NULL ON UPDATE CASCADE;
