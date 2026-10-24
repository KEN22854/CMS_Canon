import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';
import { SessionService } from './session.service';
import { SsoPolicy } from './sso-policy';
import { TwoFactorService } from './two-factor.service';

@Module({
  imports: [TenancyModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, TwoFactorService, LoginThrottleService, SsoPolicy],
  exports: [AuthService, SsoPolicy],
})
export class IdentityModule {}
