import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { TesourariaModule } from '../tesouraria/tesouraria.module';
import { RetencaoModule } from '../retencao/retencao.module';
import { AdminTesourariaController } from '../tesouraria/tesouraria.controller';
import {
  AdminOpsController,
  PainelDashboardController,
  WebhooksClienteController,
} from './ops.controller';
import { RelatorioMetodoService } from './relatorio-metodo.service';
import { RelatorioResultadoService } from './relatorio-resultado.service';

@Module({
  imports: [AuthModule, TesourariaModule, ProvidersModule, RetencaoModule],
  controllers: [
    AdminOpsController,
    AdminTesourariaController,
    PainelDashboardController,
    WebhooksClienteController,
  ],
  providers: [RelatorioMetodoService, RelatorioResultadoService],
})
export class OpsModule {}
