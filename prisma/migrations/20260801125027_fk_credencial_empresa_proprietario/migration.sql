-- AddForeignKey
ALTER TABLE "credenciais_api" ADD CONSTRAINT "credenciais_api_empresa_usuario_fk" FOREIGN KEY ("empresa_id", "usuario_id") REFERENCES "empresas"("id", "usuario_proprietario_id") ON DELETE RESTRICT ON UPDATE CASCADE;
