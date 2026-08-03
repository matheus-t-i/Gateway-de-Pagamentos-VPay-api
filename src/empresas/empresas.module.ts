import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminEmpresasController, EmpresasController } from './empresas.controller';

@Module({
  imports: [AuthModule],
  controllers: [EmpresasController, AdminEmpresasController],
})
export class EmpresasModule {}
