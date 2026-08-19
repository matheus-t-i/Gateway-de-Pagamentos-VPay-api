import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SegurancaController } from './seguranca.controller';
import { FloodV1Middleware } from './flood-v1.middleware';
import { RegistroAcessoApiMiddleware } from './registro-acesso-api.middleware';

/**
 * Trilha das rotas sensíveis (`/v1/*`) e a tela que a consulta.
 *
 * Os middlewares (trilha e teto de flood pré-roteamento) são apenas
 * EXPORTADOS como providers — quem os instala na cadeia é o `main.ts`, com
 * `app.use` cru. Motivo em detalhe lá: com Express 5 o `forRoutes('*')` não
 * casa rota nenhuma e o middleware nunca roda, em silêncio.
 */
@Module({
  imports: [AuthModule],
  controllers: [SegurancaController],
  providers: [RegistroAcessoApiMiddleware, FloodV1Middleware],
  exports: [RegistroAcessoApiMiddleware, FloodV1Middleware],
})
export class SegurancaModule {}
