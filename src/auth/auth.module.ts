import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  JWT_AUDIENCE_PAINEL,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminPendenciasController } from './admin-pendencias.controller';
import { AdminUsuariosController } from './admin-usuarios.controller';
import { ContaController } from './conta.controller';
import { SenhaController } from './senha.controller';
import { TotpController } from './totp.controller';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '1h') as `${number}h`,
          issuer: JWT_ISSUER(),
          audience: JWT_AUDIENCE_PAINEL(),
        },
      }),
    }),
  ],
  controllers: [
    AuthController,
    AdminPendenciasController,
    AdminUsuariosController,
    ContaController,
    SenhaController,
    TotpController,
  ],
  providers: [JwtAuthGuard],
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
