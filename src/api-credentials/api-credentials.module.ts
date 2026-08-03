import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeyGuard, IdempotencyInterceptor } from './api-key.guard';
import { CredenciaisController } from './credenciais.controller';
import { RateLimitService } from './rate-limit.service';

/** Global: o RateLimitService alimenta o guard de throttle por IP em todo lugar. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [CredenciaisController],
  providers: [ApiKeyGuard, IdempotencyInterceptor, RateLimitService],
  exports: [ApiKeyGuard, IdempotencyInterceptor, RateLimitService],
})
export class ApiCredentialsModule {}
