import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { API_KEY_SCOPE_NAMES, type ApiKeyScope } from '../../common/auth/abilities';
import { generateApiKey } from '../../common/auth/api-key.authenticator';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { forbidden, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const createApiKeyBody = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPE_NAMES as [ApiKeyScope, ...ApiKeyScope[]])).min(1),
  /** Agent keys: lower default rate limit and every action is flagged aiInvolved in the audit log. */
  isAgentKey: z.boolean().default(false),
  rateLimitPerMin: z.number().int().min(1).max(10_000).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
type CreateApiKeyBody = z.infer<typeof createApiKeyBody>;

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(actor: TenantPrincipal, body: CreateApiKeyBody, req: Request) {
    if (!actor.userId) throw forbidden('API keys cannot mint other API keys');
    const { key, keyPrefix, keyHash } = generateApiKey();
    const row = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).apiKey.create({
      data: {
        tenantId: actor.tenantId,
        name: body.name,
        keyPrefix,
        keyHash,
        scopes: body.scopes,
        isAgentKey: body.isAgentKey,
        rateLimit: body.rateLimitPerMin ?? null,
        expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
        createdById: actor.userId,
      },
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'api_key.created', entityType: 'ApiKey', entityId: row.id, changes: { scopes: body.scopes, isAgentKey: body.isAgentKey } }, actor, req);
    // The only time the secret leaves the server.
    return { ...present(row), key };
  }

  async list(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).apiKey.findMany({ where: { tenantId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
    return rows.map(present);
  }

  async revoke(actor: TenantPrincipal, id: string, req: Request): Promise<void> {
    const res = await this.prisma
      .forTenant({ tenantId: actor.tenantId, userId: actor.userId })
      .apiKey.updateMany({ where: { id, tenantId: actor.tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw notFound('API key');
    await this.audit.record({ tenantId: actor.tenantId, action: 'api_key.revoked', entityType: 'ApiKey', entityId: id }, actor, req);
  }
}

function present(k: { id: string; name: string; keyPrefix: string; scopes: string[]; isAgentKey: boolean; rateLimit: number | null; lastUsedAt: Date | null; expiresAt: Date | null; createdAt: Date }) {
  return { id: k.id, name: k.name, keyPrefix: k.keyPrefix, scopes: k.scopes, isAgentKey: k.isAgentKey, rateLimitPerMin: k.rateLimit, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, createdAt: k.createdAt };
}

@ApiTags('api-keys')
@ApiBearerAuth()
@Controller({ path: 'api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes')
  scopes() {
    return API_KEY_SCOPE_NAMES;
  }

  @Get()
  @RequirePermission('read', 'ApiKey')
  list(@TenantScope() p: TenantPrincipal) {
    return this.keys.list(p.tenantId);
  }

  @Post()
  @RequirePermission('create', 'ApiKey')
  @ApiOperation({ summary: 'Create a scoped key; the secret is returned once' })
  create(@Body(new ZodBody(createApiKeyBody)) body: CreateApiKeyBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.keys.create(p, body, req);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('delete', 'ApiKey')
  async revoke(@Param('id') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request): Promise<void> {
    await this.keys.revoke(p, id, req);
  }
}

@Module({ controllers: [ApiKeysController], providers: [ApiKeysService] })
export class ApiKeysModule {}
