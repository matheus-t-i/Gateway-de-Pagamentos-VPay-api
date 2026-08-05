import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProvidersModule } from '../providers/providers.module';
import { TesourariaModule } from '../tesouraria/tesouraria.module';
import { AdminTesourariaController } from '../tesouraria/tesouraria.controller';
import {
  AdminOpsController,
  PainelDashboardController,
  WebhooksClienteController,
} from './ops.controller';

@Module({
  imports: [AuthModule, TesourariaModule, ProvidersModule],
  controllers: [
    AdminOpsController,
    AdminTesourariaController,
    PainelDashboardController,
    WebhooksClienteController,
  ],
})
export class OpsModule {}
