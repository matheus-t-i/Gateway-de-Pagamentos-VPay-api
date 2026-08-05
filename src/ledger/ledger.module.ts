import { Module } from '@nestjs/common';
import { CarteirasController } from './carteiras.controller';
import { ConfigPixService, LedgerService } from './ledger.service';

@Module({
  controllers: [CarteirasController],
  providers: [LedgerService, ConfigPixService],
  exports: [LedgerService, ConfigPixService],
})
export class LedgerModule {}
