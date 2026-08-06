import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegracoesController } from './integracoes.controller';
import { IntegracoesService } from './integracoes.service';
import { UtmifyClient } from './utmify/utmify.client';
import { XtrackyClient } from './xtracky/xtracky.client';

/**
 * Apps conectados pelo lojista. Importado pela API (pelo controller do painel e
 * pelo gancho de criação da cobrança) e pelo worker (pelo processor da fila
 * `12-integracao-envio`) — por isso o service é exportado.
 */
@Module({
  imports: [AuthModule],
  controllers: [IntegracoesController],
  providers: [IntegracoesService, UtmifyClient, XtrackyClient],
  exports: [IntegracoesService, UtmifyClient, XtrackyClient],
})
export class IntegracoesModule {}
