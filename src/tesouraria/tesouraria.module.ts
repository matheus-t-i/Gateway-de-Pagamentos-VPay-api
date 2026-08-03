import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { TesourariaService } from './tesouraria.service';

/**
 * Só o serviço: o worker importa este módulo e não deve carregar controller
 * nem AuthModule. O controller admin é registrado pelo OpsModule (API).
 */
@Module({
  imports: [ProvidersModule],
  providers: [TesourariaService],
  exports: [TesourariaService],
})
export class TesourariaModule {}
