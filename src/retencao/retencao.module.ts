import { Module, forwardRef } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { MedModule } from '../med/med.module';
import { CashInCreditoService } from './cashin-credito.service';
import { AdminRetencaoController } from './retencao.controller';
import { RetencaoMetodoService } from './retencao-metodo.service';

@Module({
  imports: [LedgerModule, forwardRef(() => MedModule)],
  controllers: [AdminRetencaoController],
  providers: [RetencaoMetodoService, CashInCreditoService],
  exports: [RetencaoMetodoService, CashInCreditoService],
})
export class RetencaoModule {}
