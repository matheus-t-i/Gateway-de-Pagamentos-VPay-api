import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TesourariaModule } from '../tesouraria/tesouraria.module';
import { AdminTesourariaController } from '../tesouraria/tesouraria.controller';
import {
  AdminOpsController,
  PainelDashboardController,
  WebhooksEmpresaController,
} from './ops.controller';

@Module({
  imports: [AuthModule, TesourariaModule],
  controllers: [
    AdminOpsController,
    AdminTesourariaController,
    PainelDashboardController,
    WebhooksEmpresaController,
  ],
})
export class OpsModule {}
