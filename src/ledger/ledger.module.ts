import { Module } from '@nestjs/common';
import { ConfigPixService, LedgerService } from './ledger.service';

@Module({
  providers: [LedgerService, ConfigPixService],
  exports: [LedgerService, ConfigPixService],
})
export class LedgerModule {}
