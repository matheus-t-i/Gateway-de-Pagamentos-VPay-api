import { Module } from '@nestjs/common';
import { CarteirasController } from './carteiras.controller';
import { BloqueiosSaldoService } from './bloqueios-saldo.service';
import { ConfigPixService, LedgerService } from './ledger.service';
import { SaqueProtecaoService } from '../pix/saque-protecao.service';

@Module({
  controllers: [CarteirasController],
  providers: [
    LedgerService,
    ConfigPixService,
    BloqueiosSaldoService,
    SaqueProtecaoService,
  ],
  exports: [
    LedgerService,
    ConfigPixService,
    BloqueiosSaldoService,
    SaqueProtecaoService,
  ],
})
export class LedgerModule {}
