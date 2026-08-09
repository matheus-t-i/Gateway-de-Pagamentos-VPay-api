-- AlterTable
ALTER TABLE "credenciais_api" ADD COLUMN     "segredo_anterior_expira_em" TIMESTAMPTZ,
ADD COLUMN     "segredo_hash_anterior" VARCHAR(255);
