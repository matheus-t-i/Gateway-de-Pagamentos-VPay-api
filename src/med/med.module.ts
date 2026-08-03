import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MedController } from './med.controller';
import { MedService } from './med.service';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [MedController],
  providers: [MedService],
  exports: [MedService],
})
export class MedModule {}
