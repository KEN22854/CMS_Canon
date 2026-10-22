import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public, RateLimit, RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { Principal, TenantScope, type RequestPrincipal, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { InvitationsService } from './invitations.service';
import { MembersService } from './members.service';
import {
  acceptInviteBody,
  changeRoleBody,
  createTenantBody,
  inviteBody,
  updateTenantBody,
  type ChangeRoleBody,
  type CreateTenantBody,
  type InviteBody,
  type UpdateTenantBody,
} from './tenancy.dto';
import { TenantsService } from './tenants.service';

/**
 * `:tenantId` in the path must be the caller's *active* tenant. The path is for REST
 * readability; authority comes from the token, so a forged id is rejected, never honoured.
 */
function assertActive(p: TenantPrincipal, tenantId: string): void {
  if (p.tenantId !== tenantId) throw forbidden('Switch to this tenant first (POST /v1/auth/switch-tenant)', { reason: 'TENANT_MISMATCH' });
}

@ApiTags('tenants')
@ApiBearerAuth()
@Controller({ path: 'tenants', version: '1' })
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @ApiOperation({ summary: 'Tenants the current user belongs to' })
  mine(@Principal() p: RequestPrincipal) {
    if (!p.userId) throw forbidden('API keys are bound to a single tenant');
    return this.tenants.listForUser(p.userId);
  }

  @Post()
  @RateLimit({ bucket: 'tenant-create', limit: 5, windowSec: 3_600, by: 'principal' })
  @ApiOperation({ summary: 'Create a tenant (caller becomes OWNER); onboarding step 1' })
  async create(@Body(new ZodBody(createTenantBody)) body: CreateTenantBody, @Principal() p: RequestPrincipal) {
    if (!p.userId) throw forbidden('API keys cannot create tenants');
    const t = await this.tenants.createForOwner(p.userId, body);
    return { id: t.id, name: t.name, slug: t.slug, plan: t.plan, role: 'OWNER' as const };
  }

  @Get(':tenantId')
  @RequirePermission('read', 'Tenant')
  async get(@Param('tenantId') tenantId: string, @TenantScope() p: TenantPrincipal) {
    assertActive(p, tenantId);
    const t = await this.tenants.get(tenantId);
    return { id: t.id, name: t.name, slug: t.slug, plan: t.plan, settings: t.settings, aiSettings: t.aiSettings, trialEndsAt: t.trialEndsAt, createdAt: t.createdAt };
  }

  @Patch(':tenantId')
  @RequirePermission('update', 'Tenant')
  async update(@Param('tenantId') tenantId: string, @Body(new ZodBody(updateTenantBody)) body: UpdateTenantBody, @TenantScope() p: TenantPrincipal) {
    assertActive(p, tenantId);
    const t = await this.tenants.update(p, tenantId, body);
    return { id: t.id, name: t.name, settings: t.settings, aiSettings: t.aiSettings };
  }

  @Delete(':tenantId')
  @HttpCode(204)
  @RequirePermission('delete', 'Tenant')
  async remove(@Param('tenantId') tenantId: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    assertActive(p, tenantId);
    await this.tenants.softDelete(p, tenantId);
  }

  @Get(':tenantId/quota')
  @RequirePermission('read', 'Tenant')
  @ApiOperation({ summary: 'Plan limits and current consumption' })
  quota(@Param('tenantId') tenantId: string, @TenantScope() p: TenantPrincipal) {
    assertActive(p, tenantId);
    return this.tenants.quotaUsage(tenantId);
  }
}

@ApiTags('members')
@ApiBearerAuth()
@Controller({ path: 'tenants/:tenantId', version: '1' })
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
  ) {}

  @Get('members')
  @RequirePermission('read', 'Member')
  list(@Param('tenantId') tenantId: string, @TenantScope() p: TenantPrincipal) {
    assertActive(p, tenantId);
    return this.members.list(tenantId);
  }

  @Post('members/invite')
  @RequirePermission('invite', 'Member')
  @RateLimit({ bucket: 'invite', limit: 30, windowSec: 3_600, by: 'principal' })
  invite(@Param('tenantId') tenantId: string, @Body(new ZodBody(inviteBody)) body: InviteBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    assertActive(p, tenantId);
    return this.invitations.invite(p, abilityOf(req), body, req);
  }

  @Get('invitations')
  @RequirePermission('invite', 'Member')
  pending(@Param('tenantId') tenantId: string, @TenantScope() p: TenantPrincipal) {
    assertActive(p, tenantId);
    return this.invitations.listPending(tenantId);
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  @RequirePermission('invite', 'Member')
  async revokeInvite(@Param('tenantId') tenantId: string, @Param('invitationId') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request): Promise<void> {
    assertActive(p, tenantId);
    await this.invitations.revoke(p, id, req);
  }

  @Patch('members/:userId')
  @RequirePermission('update', 'Member')
  changeRole(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body(new ZodBody(changeRoleBody)) body: ChangeRoleBody,
    @TenantScope() p: TenantPrincipal,
    @Req() req: Request,
  ) {
    assertActive(p, tenantId);
    return this.members.changeRole(p, abilityOf(req), userId, body.role, req);
  }

  /** Any member may leave; removing others needs `delete Member` (checked in the service). */
  @Delete('members/:userId')
  @HttpCode(204)
  @RequirePermission('read', 'Member')
  async remove(@Param('tenantId') tenantId: string, @Param('userId') userId: string, @TenantScope() p: TenantPrincipal, @Req() req: Request): Promise<void> {
    assertActive(p, tenantId);
    await this.members.remove(p, abilityOf(req), userId, req);
  }
}

@ApiTags('invitations')
@Controller({ path: 'invitations', version: '1' })
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(':token')
  @RateLimit({ bucket: 'invite-preview', limit: 30, windowSec: 600, by: 'ip' })
  @ApiOperation({ summary: 'Preview an invitation (public; powers the accept page)' })
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept an invitation as the signed-in user, then switch-tenant to use it' })
  async accept(@Body(new ZodBody(acceptInviteBody)) body: { token: string }, @Principal() p: RequestPrincipal) {
    if (!p.userId) throw forbidden('Invitations are accepted by people, not API keys');
    return this.invitations.acceptAs(body.token, p.userId);
  }
}
