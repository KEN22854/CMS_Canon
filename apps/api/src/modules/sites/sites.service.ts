import { Prisma, type Site } from '@canon/db';
import { createId } from '@paralleldrive/cuid2';
import { Inject, Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { badRequest, conflict, notFound, quotaExceeded } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { TenantsService, slugify } from '../tenancy/tenants.service';
import type { CreateSiteBody, SiteAiSettingsBody, ThemeBody, UpdateSiteBody } from './sites.dto';
import { starterHome } from './starter-content';

export const DEFAULT_THEME = { colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#0f172a', muted: '#f1f5f9' }, font: 'system', radius: 'md', mode: 'auto' } as const;

export type PublicSite = ReturnType<typeof presentSite>;

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly tenants: TenantsService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).site.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { pages: { where: { deletedAt: null } } } } },
    });
    return rows.map((s) => ({ ...presentSite(s, this.config), pageCount: s._count.pages }));
  }

  async get(tenantId: string, siteId: string): Promise<Site> {
    const site = await this.prisma.forTenant({ tenantId }).site.findFirst({ where: { id: siteId, tenantId, deletedAt: null } });
    if (!site) throw notFound('Site');
    return site;
  }

  async create(actor: TenantPrincipal, body: CreateSiteBody) {
    const tenant = await this.tenants.get(actor.tenantId);
    const limit = this.tenants.limits(tenant).sites;
    const db = this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId });
    if (limit !== null && (await db.site.count({ where: { tenantId: actor.tenantId, deletedAt: null } })) >= limit) {
      throw quotaExceeded(`Your ${tenant.plan} plan allows ${limit} site${limit === 1 ? '' : 's'}`, { resource: 'sites', limit });
    }
    const slug = body.slug ?? slugify(body.name);
    const locales = [...new Set([body.defaultLocale, ...(body.locales ?? [])])];
    const internalDomain = await this.allocateInternalDomain(slug, tenant.slug);

    try {
      const site = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
        const created = await tx.site.create({
          data: { tenantId: actor.tenantId, name: body.name, slug, description: body.description ?? null, internalDomain, defaultLocale: body.defaultLocale, locales, theme: DEFAULT_THEME },
        });
        const content = starterHome(body.template, body.name);
        await tx.page.create({
          data: { tenantId: actor.tenantId, siteId: created.id, slug: '', fullPath: '/', title: 'Home', locale: body.defaultLocale, content: content as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null, updatedById: actor.userId ?? null },
        });
        await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Site', aggregateId: created.id, type: 'SiteCreated', payload: { siteId: created.id, internalDomain } });
        return created;
      });
      await this.audit.record({ tenantId: actor.tenantId, action: 'site.created', entityType: 'Site', entityId: site.id, changes: { name: body.name, template: body.template } }, actor);
      return presentSite(site, this.config);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict(`A site with slug "${slug}" already exists`);
      throw err;
    }
  }

  async update(actor: TenantPrincipal, siteId: string, body: UpdateSiteBody) {
    const current = await this.get(actor.tenantId, siteId);
    const data: Prisma.SiteUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.favicon !== undefined) data.favicon = body.favicon;
    if (body.logo !== undefined) data.logo = body.logo;
    if (body.seoDefaults) data.seoDefaults = { ...(current.seoDefaults as object), ...body.seoDefaults };
    if (body.settings) data.settings = { ...(current.settings as object), ...body.settings } as Prisma.InputJsonValue;
    if (body.locales || body.defaultLocale) {
      const locales = body.locales ?? current.locales;
      const def = body.defaultLocale ?? current.defaultLocale;
      if (!locales.includes(def)) throw badRequest('INVALID_LOCALES', 'The default locale must be one of the site locales');
      data.locales = locales;
      data.defaultLocale = def;
    }
    if (body.domain !== undefined) {
      if (body.domain && body.domain.endsWith(`.${this.config.PUBLIC_SITES_DOMAIN}`)) throw badRequest('INVALID_DOMAIN', 'Platform subdomains are assigned automatically');
      // Global uniqueness (another tenant may own it) is a cross-tenant read by nature.
      if (body.domain && (await this.system.site.findFirst({ where: { domain: body.domain, deletedAt: null, NOT: { id: siteId } }, select: { id: true } }))) {
        throw conflict('This domain is already connected to another site');
      }
      data.domain = body.domain;
    }
    const site = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data });
    await this.siteChanged(actor, siteId, 'site.updated', body as Prisma.InputJsonValue, [current.domain, site.domain]);
    return presentSite(site, this.config);
  }

  async updateTheme(actor: TenantPrincipal, siteId: string, body: ThemeBody) {
    const current = await this.get(actor.tenantId, siteId);
    const prev = (current.theme ?? {}) as { colors?: object };
    const theme = { ...DEFAULT_THEME, ...prev, ...body, colors: { ...DEFAULT_THEME.colors, ...(prev.colors ?? {}), ...(body.colors ?? {}) } };
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data: { theme } });
    await this.siteChanged(actor, siteId, 'site.theme_updated', body as Prisma.InputJsonValue, [current.domain]);
    return theme;
  }

  async updateAiSettings(actor: TenantPrincipal, siteId: string, body: SiteAiSettingsBody) {
    const current = await this.get(actor.tenantId, siteId);
    const aiSettings = { ...(current.aiSettings as object), ...body } as Prisma.InputJsonValue;
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data: { aiSettings } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'site.ai_settings_updated', entityType: 'Site', entityId: siteId, changes: body as Prisma.InputJsonValue }, actor);
    return aiSettings;
  }

  async softDelete(actor: TenantPrincipal, siteId: string): Promise<void> {
    const site = await this.get(actor.tenantId, siteId);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.site.update({ where: { id: siteId }, data: { deletedAt: new Date(), domain: null, isPublished: false } });
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Site', aggregateId: siteId, type: 'SiteDeleted', payload: { siteId, hosts: [site.internalDomain, ...(site.domain ? [site.domain] : [])] } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'site.deleted', entityType: 'Site', entityId: siteId }, actor);
  }

  /** Every site-level change re-renders the whole site (theme, nav, locales touch every page). */
  private async siteChanged(actor: TenantPrincipal, siteId: string, action: string, changes: Prisma.InputJsonValue, extraHosts: (string | null)[]): Promise<void> {
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
      this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Site', aggregateId: siteId, type: 'SiteUpdated', payload: { siteId, hosts: extraHosts.filter((h): h is string => Boolean(h)) } }),
    );
    await this.audit.record({ tenantId: actor.tenantId, action, entityType: 'Site', entityId: siteId, changes }, actor);
  }

  private async allocateInternalDomain(siteSlug: string, tenantSlug: string): Promise<string> {
    const base = `${siteSlug}-${tenantSlug}`.slice(0, 50);
    for (let i = 0; i < 5; i++) {
      const candidate = `${i === 0 ? base : `${base}-${createId().slice(0, 4)}`}.${this.config.PUBLIC_SITES_DOMAIN}`;
      if (!(await this.system.site.findUnique({ where: { internalDomain: candidate }, select: { id: true } }))) return candidate;
    }
    throw conflict('Could not allocate a site address, try another slug');
  }
}

export function presentSite(s: Site, config: AppConfig) {
  const host = s.domain ?? s.internalDomain;
  // Dev renderer listens on a port; production hosts are served on 443 by the edge.
  const url = config.NODE_ENV === 'production' ? `https://${host}` : `http://${host}:${config.WEB_PUBLIC_PORT}`;
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    domain: s.domain,
    internalDomain: s.internalDomain,
    url,
    defaultLocale: s.defaultLocale,
    locales: s.locales,
    theme: s.theme,
    seoDefaults: s.seoDefaults,
    settings: s.settings,
    aiSettings: s.aiSettings,
    favicon: s.favicon,
    logo: s.logo,
    isPublished: s.isPublished,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
