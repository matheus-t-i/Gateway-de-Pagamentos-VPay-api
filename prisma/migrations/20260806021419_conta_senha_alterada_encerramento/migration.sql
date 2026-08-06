-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "encerrada_em" TIMESTAMPTZ,
ADD COLUMN     "motivo_encerramento" TEXT,
ADD COLUMN     "senha_alterada_em" TIMESTAMPTZ;
