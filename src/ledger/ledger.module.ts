import { Module } from '@nestjs/common';
import { CarteirasController } from './carteiras.controller';
import { BloqueiosSaldoService } from './bloqueios-saldo.service';
import { ConfigPixService, LedgerService } from './ledger.service';

@Module({
  controllers: [CarteirasController],
  providers: [LedgerService, ConfigPixService, BloqueiosSaldoService],
  exports: [LedgerService, ConfigPixService, BloqueiosSaldoService],
})
export class LedgerModule {}
