import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AccessTokenService } from './access-token.service';
import { ApiKeyAuthenticator } from './api-key.authenticator';
import { AuthGuard } from './auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { RateLimitGuard } from './rate-limit.guard';
import { SessionRevoker } from './session-revoker';

/**
 * Global guard chain, in order: authenticate → rate-limit (can key on the principal) → authorize.
 * Registered here once so no feature module can forget it.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  providers: [
    AccessTokenService,
    ApiKeyAuthenticator,
    SessionRevoker,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AccessTokenService, ApiKeyAuthenticator, SessionRevoker],
})
export class AuthCoreModule {}
