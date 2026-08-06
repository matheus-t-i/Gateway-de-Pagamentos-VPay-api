-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NaturezaMovimentacao" ADD VALUE 'BLOQUEIO_MANUAL';
ALTER TYPE "NaturezaMovimentacao" ADD VALUE 'DESBLOQUEIO_MANUAL';
ALTER TYPE "NaturezaMovimentacao" ADD VALUE 'DEBITO_MANUAL';

-- AlterEnum
ALTER TYPE "TipoSaldo" ADD VALUE 'BLOQUEADO_MANUAL';

-- AlterTable
ALTER TABLE "bloqueios_saldo" ADD COLUMN     "encerrado_por_usuario_id" BIGINT;

-- AlterTable
ALTER TABLE "saldos_usuarios" ADD COLUMN     "saldo_bloqueado_manual" DECIMAL(19,2) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "bloqueios_saldo_usuario_id_idx" ON "bloqueios_saldo"("usuario_id");

-- CreateIndex
CREATE INDEX "bloqueios_saldo_situacao_idx" ON "bloqueios_saldo"("situacao");

-- AddForeignKey
ALTER TABLE "bloqueios_saldo" ADD CONSTRAINT "bloqueios_saldo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
