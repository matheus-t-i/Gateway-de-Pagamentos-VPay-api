import { Module } from '@nestjs/common';
import { ApiCredentialsModule } from '../api-credentials/api-credentials.module';
import { AuthModule } from '../auth/auth.module';
import { ContingenciaModule } from '../contingencia/contingencia.module';
import { IntegracoesModule } from '../integracoes/integracoes.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ProvidersModule } from '../providers/providers.module';
import { PixApiController, PixPainelController } from './pix.controller';
import {
  AdminChavesPixController,
  ChavesPixController,
} from './chaves-pix.controller';
import { SaldoApiController } from './saldo.controller';
import { PainelCondicoesController } from './condicoes.controller';
import { PixService } from './pix.service';

@Module({
  imports: [
    AuthModule,
    ApiCredentialsModule,
    ContingenciaModule,
    IntegracoesModule,
    LedgerModule,
    ProvidersModule,
  ],
  controllers: [
    PixApiController,
    PixPainelController,
    SaldoApiController,
    PainelCondicoesController,
    ChavesPixController,
    AdminChavesPixController,
  ],
  providers: [PixService],
  exports: [PixService],
})
export class PixModule {}
