import { forwardRef, Module } from '@nestjs/common';
import { MockPaymentProvider } from './mock/mock.client';
import { MockWebhookController } from './mock/mock.webhook.controller';
import { ProviderRegistry } from './provider.registry';
import { MedModule } from '../med/med.module';

@Module({
  // forwardRef: MedModule usa LedgerModule, que também é usado por quem importa
  // ProvidersModule — evita ciclo na resolução.
  imports: [forwardRef(() => MedModule)],
  controllers: [MockWebhookController],
  providers: [MockPaymentProvider, ProviderRegistry],
  exports: [MockPaymentProvider, ProviderRegistry],
})
export class ProvidersModule {}
