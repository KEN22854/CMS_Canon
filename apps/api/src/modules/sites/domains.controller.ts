import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public, RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { DomainsService } from './domains.service';

@ApiTags('sites')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/domain', version: '1' })
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @RequirePermission('read', 'Site')
  @ApiOperation({ summary: 'Custom domain status and the DNS records to create' })
  status(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.domains.status(p.tenantId, siteId);
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Check the TXT record now; on success the site is served on the domain' })
  verify(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.domains.verify(p, siteId);
  }
}

/** Edge integration: Caddy's on-demand TLS asks here before requesting a certificate. */
@Public()
@Controller({ path: 'tls', version: '1' })
export class TlsAskController {
  constructor(private readonly domains: DomainsService) {}

  @Get('ask')
  @ApiExcludeEndpoint()
  async ask(@Query('domain') domain?: string) {
    if (!domain || !(await this.domains.allowsCertificate(domain))) throw new NotFoundException();
    return { ok: true };
  }
}
