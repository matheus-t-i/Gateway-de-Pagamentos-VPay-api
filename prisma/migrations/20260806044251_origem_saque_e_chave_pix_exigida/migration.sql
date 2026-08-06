-- CreateEnum
CREATE TYPE "OrigemSaque" AS ENUM ('PAINEL', 'API', 'AMBOS');

-- AlterTable
ALTER TABLE "configuracoes_padrao_pix_usuarios" ADD COLUMN     "exigir_chave_pix_cadastrada" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "origem_saque_permitida" "OrigemSaque" NOT NULL DEFAULT 'PAINEL';

-- AlterTable
ALTER TABLE "configuracoes_pix_usuarios" ADD COLUMN     "exigir_chave_pix_cadastrada" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "origem_saque_permitida" "OrigemSaque" NOT NULL DEFAULT 'PAINEL';

-- Backfill: quem já tinha saque via API liberado continua com API + painel.
-- Sem isto a migração TIRARIA acesso de quem estava operando por API.
UPDATE "configuracoes_pix_usuarios"
   SET "origem_saque_permitida" = 'AMBOS'
 WHERE "permitir_pix_saida_via_api" = true;

UPDATE "configuracoes_padrao_pix_usuarios"
   SET "origem_saque_permitida" = 'AMBOS'
 WHERE "permitir_pix_saida_via_api" = true;
