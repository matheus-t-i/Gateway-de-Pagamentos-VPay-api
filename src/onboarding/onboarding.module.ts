import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { AdminDocumentosController } from './admin-documentos.controller';

/**
 * Onboarding público (cadastro/envio de documentos, sem JWT) + revisão admin dos
 * documentos. PrismaService e JwtService são globais, então basta declarar os
 * controllers.
 */
@Module({
  controllers: [OnboardingController, AdminDocumentosController],
})
export class OnboardingModule {}
