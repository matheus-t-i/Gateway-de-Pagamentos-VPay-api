-- AddForeignKey
ALTER TABLE "casos_med" ADD CONSTRAINT "casos_med_empresa_id_fkey" FOREIGN KEY ("empresa_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
