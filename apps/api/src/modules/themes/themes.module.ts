import { THEME_FONTS, THEME_RADII } from '@canon/blocks';
import type { Prisma } from '@canon/db';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TenantsService } from '../tenancy/tenants.service';

const MAX_THEMES = 30;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A complete theme (the same tokens PATCH /sites/:id/theme accepts). */
export const themeTokensSchema = z
  .object({
    colors: z.object({ primary: color, background: color, foreground: color, muted: color }).strict(),
    font: z.enum(THEME_FONTS),
    radius: z.enum(THEME_RADII),
    mode: z.enum(['light', 'dark', 'auto']),
  })
  .strict();
const saveBody = z.object({ name: z.string().trim().min(1).max(60), theme: themeTokensSchema });
type SaveBody = z.infer<typeof saveBody>;

interface StoredTheme {
  id: string;
  name: string;
  theme: z.infer<typeof themeTokensSchema>;
  createdAt: string;
}

/**
 * Workspace themes (Stage 10): a team's own themes, shared by all its sites — save the current
 * theme of one site, apply it to another. Kept in the workspace settings (small, bounded list).
 */
@Injectable()
export class ThemesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<StoredTheme[]> {
    return this.read((await this.tenants.get(tenantId)).settings);
  }

  async save(actor: TenantPrincipal, body: SaveBody): Promise<StoredTheme> {
    const tenant = await this.tenants.get(actor.tenantId);
    const themes = this.read(tenant.settings);
    if (themes.length >= MAX_THEMES) throw badRequest('TOO_MANY_THEMES', `A workspace keeps up to ${MAX_THEMES} themes`);
    const item: StoredTheme = { id: globalThis.crypto.randomUUID().slice(0, 12).replace(/-/g, ''), name: body.name, theme: body.theme, createdAt: new Date().toISOString() };
    await this.write(actor, tenant.settings, [...themes, item]);
    await this.audit.record({ tenantId: actor.tenantId, action: 'theme.saved', entityType: 'Tenant', entityId: actor.tenantId, changes: { name: body.name } }, actor);
    return item;
  }

  async remove(actor: TenantPrincipal, id: string): Promise<void> {
    const tenant = await this.tenants.get(actor.tenantId);
    const themes = this.read(tenant.settings);
    if (!themes.some((t) => t.id === id)) throw notFound('Theme');
    await this.write(actor, tenant.settings, themes.filter((t) => t.id !== id));
  }

  private read(settings: unknown): StoredTheme[] {
    const raw = (settings as { themes?: unknown } | null)?.themes;
    return Array.isArray(raw) ? (raw as StoredTheme[]).filter((t) => themeTokensSchema.safeParse(t.theme).success) : [];
  }

  private async write(actor: TenantPrincipal, settings: unknown, themes: StoredTheme[]): Promise<void> {
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).tenant.update({ where: { id: actor.tenantId }, data: { settings: { ...((settings as object) ?? {}), themes } as unknown as Prisma.InputJsonValue } });
  }
}

@ApiTags('themes')
@ApiBearerAuth()
@Controller({ path: 'themes', version: '1' })
export class ThemesController {
  constructor(private readonly themes: ThemesService) {}

  @Get()
  @RequirePermission('read', 'Site')
  list(@TenantScope() p: TenantPrincipal) {
    return this.themes.list(p.tenantId);
  }

  @Post()
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Save a theme for every site of the workspace (apply it with PATCH /sites/:id/theme)' })
  save(@Body(new ZodBody(saveBody)) body: SaveBody, @TenantScope() p: TenantPrincipal) {
    return this.themes.save(p, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('update', 'Site')
  async remove(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.themes.remove(p, id);
  }
}

@Module({
  imports: [TenancyModule],
  controllers: [ThemesController],
  providers: [ThemesService],
})
export class ThemesModule {}
