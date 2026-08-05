import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PainelFaturamentoController } from './faturamento.controller';

@Module({
  imports: [AuthModule],
  controllers: [PainelFaturamentoController],
})
export class FaturamentoModule {}
