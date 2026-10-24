import { Body, Controller, Delete, Get, HttpCode, Inject, Module, Param, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public, RateLimit, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { setRefreshCookie } from '../identity/auth-cookies';
import { AuthService } from '../identity/auth.service';
import { IdentityModule } from '../identity/identity.module';
import { SsoService, ssoConnectionBody, type SsoConnectionBody } from './sso.service';

const discoverBody = z.object({ email: z.email().max(254) });
const verifyBody = z.object({ domain: z.string().trim().toLowerCase().max(253) });

@ApiTags('sso')
@ApiBearerAuth()
@Controller({ path: 'sso', version: '1' })
export class SsoAdminController {
  constructor(private readonly sso: SsoService) {}

  @Get()
  @RequirePermission('update', 'Tenant')
  @ApiOperation({ summary: 'SSO connection, service-provider URLs for the IdP, and domain verification records' })
  get(@TenantScope() p: TenantPrincipal) {
    return this.sso.get(p.tenantId);
  }

  @Put()
  @RequirePermission('update', 'Tenant')
  @ApiOperation({ summary: 'Create or update the SAML connection (Enterprise)' })
  upsert(@Body(new ZodBody(ssoConnectionBody)) body: SsoConnectionBody, @TenantScope() p: TenantPrincipal) {
    return this.sso.upsert(p, body);
  }

  @Post('domains/verify')
  @HttpCode(200)
  @RequirePermission('update', 'Tenant')
  @RateLimit({ bucket: 'sso-verify', limit: 30, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'Check the DNS TXT record that proves a domain belongs to this workspace' })
  verify(@Body(new ZodBody(verifyBody)) body: z.infer<typeof verifyBody>, @TenantScope() p: TenantPrincipal) {
    return this.sso.verifyDomain(p, body.domain);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission('update', 'Tenant')
  async remove(@TenantScope() p: TenantPrincipal): Promise<void> {
    await this.sso.remove(p);
  }
}

@ApiTags('sso')
@Controller({ path: 'auth/sso', version: '1' })
export class SsoLoginController {
  constructor(
    private readonly sso: SsoService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('discover')
  @HttpCode(200)
  @RateLimit({ bucket: 'sso-discover', limit: 30, windowSec: 60, by: 'ip' })
  @ApiOperation({ summary: 'Does this email sign in through an identity provider? (login page, step 1)' })
  discover(@Body(new ZodBody(discoverBody)) body: z.infer<typeof discoverBody>) {
    return this.sso.discover(body.email);
  }

  @Public()
  @Get('saml/:id/login')
  @ApiExcludeEndpoint()
  async login(@Param('id') id: string, @Res() res: Response): Promise<void> {
    try {
      res.redirect(302, await this.sso.authorizeUrl(id));
    } catch (err) {
      this.fail(res, err);
    }
  }

  @Public()
  @Get('saml/:id/metadata')
  @ApiOperation({ summary: 'SAML service-provider metadata to upload to the IdP' })
  async metadata(@Param('id') id: string, @Res() res: Response): Promise<void> {
    res.type('application/samlmetadata+xml').send(await this.sso.metadata(id));
  }

  /** Assertion consumer service: the IdP POSTs here via the browser. */
  @Public()
  @Post('saml/:id/acs')
  @RateLimit({ bucket: 'sso-acs', limit: 60, windowSec: 60, by: 'ip' })
  @ApiExcludeEndpoint()
  async acs(@Param('id') id: string, @Body() body: Record<string, string>, @Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      if (typeof body?.SAMLResponse !== 'string') throw new ApiError('SSO_INVALID_RESPONSE', 'Missing SAMLResponse', 400);
      const { user, tenantId } = await this.sso.consume(id, { SAMLResponse: body.SAMLResponse, ...(typeof body.RelayState === 'string' ? { RelayState: body.RelayState } : {}) });
      const result = await this.auth.startFederatedSession(user, tenantId, { ip: req.ip, userAgent: req.header('user-agent') });
      setRefreshCookie(res, this.config, result.session.refreshToken, result.session.expiresAt);
      // The admin exchanges the cookie for an access token on this page (a same-site request).
      res.redirect(303, `${this.config.ADMIN_PUBLIC_URL}/sso/callback`);
    } catch (err) {
      this.fail(res, err);
    }
  }

  private fail(res: Response, err: unknown): void {
    const code = err instanceof ApiError ? err.code : 'SSO_FAILED';
    res.redirect(303, `${this.config.ADMIN_PUBLIC_URL}/login?sso_error=${encodeURIComponent(String(code))}`);
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [SsoAdminController, SsoLoginController],
  providers: [SsoService],
})
export class SsoModule {}
