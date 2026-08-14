import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SegurancaController } from './seguranca.controller';
import { RegistroAcessoApiMiddleware } from './registro-acesso-api.middleware';

/**
 * Trilha das rotas sensíveis (`/v1/*`) e a tela que a consulta.
 *
 * O middleware é apenas EXPORTADO como provider — quem o instala na cadeia é
 * o `main.ts`, com `app.use` cru. Motivo em detalhe lá: com Express 5 o
 * `forRoutes('*')` não casa rota nenhuma e o middleware nunca roda, em
 * silêncio.
 */
@Module({
  imports: [AuthModule],
  controllers: [SegurancaController],
  providers: [RegistroAcessoApiMiddleware],
  exports: [RegistroAcessoApiMiddleware],
})
export class SegurancaModule {}
