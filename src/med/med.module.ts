import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MedController } from './med.controller';
import { MedService } from './med.service';
import { MedAutomaticoService } from './med-automatico.service';
import { AdminMedAutomaticoController } from './med-automatico.controller';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [MedController, AdminMedAutomaticoController],
  providers: [MedService, MedAutomaticoService],
  exports: [MedService, MedAutomaticoService],
})
export class MedModule {}
