-- AlterEnum
ALTER TYPE "TipoIntegracao" ADD VALUE 'XTRACKY';

-- AlterTable
ALTER TABLE "integracoes_usuario" ALTER COLUMN "credenciais_criptografadas" DROP NOT NULL;
