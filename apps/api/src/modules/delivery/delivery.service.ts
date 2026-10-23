import { collectMediaIds, collectPageFactKeys, type PageContent } from '@canon/blocks';
import type { Page, Site } from '@canon/db';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { MediaService } from '../media/media.service';
import { PagesService } from '../pages/pages.service';
import { DEFAULT_THEME } from '../sites/sites.service';

const CACHE_TTL_SEC = 300;
const INVALIDATING_EVENTS = ['PagePublished', 'PageUnpublished', 'PageMoved', 'SiteUpdated', 'SiteDeleted', 'EntryPublished', 'EntryUnpublished', 'CollectionUpdated', 'CollectionDeleted', 'FactChanged'];

/**
 * Read model for the public renderer. Runs on the system role because the visitor has no tenant
 * context — every query is therefore pinned to a resolved siteId and to *published* snapshots
 * (PageVersion at publishedVersion), so drafts can never leak through this path.
 */
@Injectable()
export class DeliveryService implements OnModuleInit {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly media: MediaService,
    private readonly pages: PagesService,
    private readonly bus: EventBus,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DeliveryService.name);
  }

  onModuleInit(): void {
    for (const type of INVALIDATING_EVENTS) this.bus.on(type, (e) => this.invalidate(e));
  }

  async resolve(host: string) {
    const h = host.toLowerCase().replace(/:\d+$/, '');
    const site = await this.system.site.findFirst({ where: { deletedAt: null, OR: [{ domain: h }, { internalDomain: h }] } });
    if (!site) throw notFound('Site');
    return presentSite(site);
  }

  async page(siteId: string, rawPath: string, locale?: string) {
    const path = normalizePath(rawPath);
    const site = await this.site(siteId);
    const loc = locale && site.locales.includes(locale) ? locale : site.defaultLocale;
    const cacheKey = `dlv:${siteId}:${await this.siteVersion(siteId)}:${loc}:${path}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as unknown;

    const page = await this.system.page.findFirst({ where: { siteId, fullPath: path, locale: loc, deletedAt: null, publishedVersion: { not: null } } });
    if (!page?.publishedVersion) throw notFound('Page');
    const snapshot = await this.system.pageVersion.findUnique({ where: { pageId_version: { pageId: page.id, version: page.publishedVersion } } });
    if (!snapshot) throw notFound('Page');

    const payload = await this.assemble(site, page, snapshot.content as unknown as PageContent, snapshot.seo as Record<string, unknown>, false);
    await this.redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SEC).catch(() => undefined);
    return payload;
  }

  /** Draft content for a signed preview link; never cached anywhere. */
  async preview(token: string) {
    const claims = await this.pages.verifyPreview(token);
    const page = await this.system.page.findFirst({ where: { id: claims.pid, siteId: claims.sid, tenantId: claims.tid, deletedAt: null } });
    if (!page) throw notFound('Page');
    const site = await this.site(page.siteId);
    return this.assemble(site, page, page.content as unknown as PageContent, page.seo as Record<string, unknown>, true);
  }

  /** Published pages for sitemaps and navigation. */
  async list(siteId: string) {
    const site = await this.site(siteId);
    const pages = await this.system.page.findMany({
      where: { siteId, deletedAt: null, publishedVersion: { not: null } },
      select: { id: true, title: true, fullPath: true, locale: true, parentId: true, position: true, updatedAt: true, publishedAt: true, translationGroupId: true, seo: true },
      orderBy: [{ locale: 'asc' }, { position: 'asc' }, { fullPath: 'asc' }],
    });
    return {
      site: presentSite(site),
      pages: pages
        .filter((p) => !(p.seo as { noindex?: boolean }).noindex)
        .map((p) => ({ id: p.id, title: p.title, path: p.fullPath, locale: p.locale, parentId: p.parentId, position: p.position, updatedAt: p.publishedAt ?? p.updatedAt, translationGroupId: p.translationGroupId })),
    };
  }

  private async assemble(site: Site, page: Page, content: PageContent, seo: Record<string, unknown>, draft: boolean) {
    const mediaIds = collectMediaIds(content);
    const ogId = typeof seo.ogImageMediaId === 'string' ? seo.ogImageMediaId : undefined;
    if (ogId) mediaIds.push(ogId);
    const factKeys = collectPageFactKeys(content);

    const [mediaRows, factRows, alternates, nav] = await Promise.all([
      mediaIds.length ? this.system.media.findMany({ where: { id: { in: mediaIds }, siteId: site.id, deletedAt: null, status: 'READY' } }) : [],
      factKeys.length ? this.system.fact.findMany({ where: { tenantId: site.tenantId, key: { in: factKeys }, deletedAt: null }, select: { key: true, displayValue: true } }) : [],
      page.translationGroupId
        ? this.system.page.findMany({ where: { translationGroupId: page.translationGroupId, siteId: site.id, deletedAt: null, publishedVersion: { not: null } }, select: { locale: true, fullPath: true } })
        : [],
      this.system.page.findMany({
        where: { siteId: site.id, locale: page.locale, parentId: null, deletedAt: null, publishedVersion: { not: null }, NOT: { fullPath: '/' } },
        select: { title: true, fullPath: true },
        orderBy: [{ position: 'asc' }, { fullPath: 'asc' }],
        take: 8,
      }),
    ]);

    return {
      draft,
      site: presentSite(site),
      page: { id: page.id, title: page.title, description: page.description, locale: page.locale, path: page.fullPath, seo, content, publishedAt: page.publishedAt, version: draft ? page.version : page.publishedVersion },
      alternates: alternates.map((a) => ({ locale: a.locale, path: a.fullPath })),
      nav: nav.map((n) => ({ title: n.title, path: n.fullPath })),
      media: Object.fromEntries(mediaRows.map((m) => [m.id, this.media.present(m)])),
      facts: Object.fromEntries(factRows.map((f) => [f.key, f.displayValue])),
    };
  }

  private async site(siteId: string): Promise<Site> {
    const site = await this.system.site.findFirst({ where: { id: siteId, deletedAt: null } });
    if (!site) throw notFound('Site');
    return site;
  }

  private async siteVersion(siteId: string): Promise<string> {
    return (await this.redis.get(`dlv:ver:${siteId}`).catch(() => null)) ?? '0';
  }

  /**
   * Cache keys embed a per-site version, so invalidation is one INCR (old keys age out by TTL)
   * instead of a SCAN over every cached path. The renderer's ISR cache is purged by tag next.
   */
  private async invalidate(e: StoredEvent): Promise<void> {
    const payload = e.payload as { siteId?: string; hosts?: string[] };
    if (!payload.siteId) return;
    await this.redis.incr(`dlv:ver:${payload.siteId}`);
    await this.revalidateRenderer([`site:${payload.siteId}`, ...(payload.hosts ?? []).map((h) => `host:${h}`)]);
  }

  private async revalidateRenderer(tags: string[]): Promise<void> {
    if (!this.config.WEB_REVALIDATE_URL) return;
    const res = await fetch(this.config.WEB_REVALIDATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canon-revalidate': this.config.REVALIDATE_SECRET },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5_000),
    }).catch((err: unknown) => {
      // Throwing makes the outbox retry with backoff; the renderer may simply be restarting.
      throw new Error(`renderer revalidation failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!res.ok) throw new Error(`renderer revalidation returned ${res.status}`);
  }
}

function presentSite(s: Site) {
  return {
    id: s.id,
    name: s.name,
    host: s.domain ?? s.internalDomain,
    defaultLocale: s.defaultLocale,
    locales: s.locales,
    theme: mergeTheme(s.theme),
    seoDefaults: s.seoDefaults,
    favicon: s.favicon,
    logo: s.logo,
  };
}

/** Deep-merge colours: a site that customised only `primary` must still get the other defaults. */
function mergeTheme(raw: unknown) {
  const t = (raw ?? {}) as { colors?: Record<string, string> } & Record<string, unknown>;
  return { ...DEFAULT_THEME, ...t, colors: { ...DEFAULT_THEME.colors, ...(t.colors ?? {}) } };
}

export function normalizePath(p: string): string {
  const clean = `/${p}`.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return clean === '' ? '/' : clean;
}
