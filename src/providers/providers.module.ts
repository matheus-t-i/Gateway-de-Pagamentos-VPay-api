import { forwardRef, Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock/mock.client';
import { MockWebhookController } from './mock/mock.webhook.controller';
import { ValorionPaymentProvider } from './valorion/valorion.client';
import { ValorionWebhookController } from './valorion/valorion.webhook.controller';
import { ProviderRegistry } from './provider.registry';
import { AdquirentesService } from './adquirentes.service';
import { MedModule } from '../med/med.module';
import { AuthModule } from '../auth/auth.module';
import {
  AdminAdquirentesVitrineController,
  PainelAdquirentesController,
} from './adquirentes.controller';
import { ProvidersProdGuard } from './providers-prod.guard';

@Module({
  // forwardRef: MedModule usa LedgerModule, que também é usado por quem importa
  // ProvidersModule — evita ciclo na resolução.
  imports: [forwardRef(() => MedModule), AuthModule],
  controllers: [
    MockWebhookController,
    ValorionWebhookController,
    PainelAdquirentesController,
    AdminAdquirentesVitrineController,
  ],
  providers: [
    MockPaymentProvider,
    ValorionPaymentProvider,
    ProviderRegistry,
    AdquirentesService,
    ProvidersProdGuard,
  ],
  exports: [MockPaymentProvider, ProviderRegistry, AdquirentesService],
})
export class ProvidersModule {}
