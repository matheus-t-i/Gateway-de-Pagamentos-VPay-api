import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiTokenGuard } from './api-token.guard';
import { CredencialAuthService } from './credencial-auth.service';
import { CredenciaisController } from './credenciais.controller';
import { RateLimitService } from './rate-limit.service';
import { TokenApiController } from './token.controller';

/** Global: o RateLimitService alimenta o guard de throttle por IP em todo lugar. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CredenciaisController, TokenApiController],
  providers: [ApiTokenGuard, CredencialAuthService, RateLimitService],
  exports: [ApiTokenGuard, CredencialAuthService, RateLimitService],
})
export class ApiCredentialsModule {}
