import { bindEntry, collectComponentIds, collectListSpecs, collectProductIds, hasCart, collectMediaIds, collectPageFactKeys, expandComponents, type BlockNode, type ListItem, type PageContent } from '@canon/blocks';
import { applyBlockPatch, decodeVariantKey, mergePatches, type BlockPatch, type RuntimeConfig } from '@canon/edge';
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
import { DEFAULT_THEME, servedHost } from '../sites/sites.service';
import { publicForm } from '../forms/forms.dto';
import { EntryPagesService, type EntryPageHit } from './entry-pages.service';

const CACHE_TTL_SEC = 300;
const INVALIDATING_EVENTS = [
  'PagePublished',
  'PageUnpublished',
  'PageMoved',
  'SiteUpdated',
  'SiteDeleted',
  'EntryPublished',
  'EntryUnpublished',
  'CollectionUpdated',
  'CollectionDeleted',
  'FactChanged',
  'ExperimentChanged',
  'PersonalizationChanged',
  'FormUpdated',
  'ComponentPublished',
  'RedirectsChanged',
  // Stock on product pages.
  'OrderPlaced',
  'OrderCancelled',
];

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
    private readonly entryPages: EntryPagesService,
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
    const site = await this.system.site.findFirst({
      where: { deletedAt: null, OR: [{ domain: h, domainStatus: 'VERIFIED' }, { internalDomain: h }] },
    });
    if (!site) throw notFound('Site');
    return presentSite(site);
  }

  /**
   * @param variantKey the proxy's rewrite key ("~t.<test>.<variant>~s.<segment>"). It is
   * re-validated here — only running tests and active personalizations of *this* page apply, so a
   * forged key renders the original page.
   */
  async page(siteId: string, rawPath: string, locale?: string, variantKey?: string) {
    const path = normalizePath(rawPath);
    const site = await this.site(siteId);
    const loc = locale && site.locales.includes(locale) ? locale : site.defaultLocale;
    const selection = decodeVariantKey(variantKey);
    const cacheKey = `dlv:${siteId}:${await this.siteVersion(siteId)}:${loc}:${path}${selection ? `:${variantKey}` : ''}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as unknown;

    const found = await this.system.page.findFirst({ where: { siteId, fullPath: path, locale: loc, deletedAt: null, publishedVersion: { not: null } } });
    const templates = await this.entryPages.templatePageIds(siteId);
    // An entry template is a mould with raw {{entry.*}} tokens, not a destination of its own.
    if (found && templates.has(found.id)) throw notFound('Page');
    if (!found) {
      const payload = await this.entryPage(site, path, loc);
      await this.redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SEC).catch(() => undefined);
      return payload;
    }
    const page = found;
    if (!page.publishedVersion) throw notFound('Page');
    const snapshot = await this.system.pageVersion.findUnique({ where: { pageId_version: { pageId: page.id, version: page.publishedVersion } } });
    if (!snapshot) throw notFound('Page');

    let content = snapshot.content as unknown as PageContent;
    const applied: { experiments: { testId: string; variantId: string }[]; segmentId: string | null } = { experiments: [], segmentId: null };
    if (selection) {
      const [tests, personalization] = await Promise.all([
        selection.experiments.length ? this.system.abTest.findMany({ where: { id: { in: selection.experiments.map((e) => e.testId) }, pageId: page.id, status: 'RUNNING' } }) : [],
        selection.segmentId ? this.system.personalization.findFirst({ where: { pageId: page.id, segmentId: selection.segmentId, status: 'ACTIVE', segment: { deletedAt: null } } }) : null,
      ]);
      const testPatches = selection.experiments.flatMap((e) => {
        const t = tests.find((x) => x.id === e.testId);
        const v = (t?.variants as { id: string; patch: BlockPatch }[] | undefined)?.find((x) => x.id === e.variantId);
        if (!v) return [];
        applied.experiments.push(e);
        return [v.patch];
      });
      if (personalization) applied.segmentId = selection.segmentId;
      // Experiment patches go last: a running test must measure exactly what it claims to.
      content = applyBlockPatch(content, mergePatches(personalization?.patch as BlockPatch | undefined, ...testPatches));
    }
    const payload = { ...(await this.assemble(site, page, content, snapshot.seo as Record<string, unknown>, false)), applied };
    await this.redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SEC).catch(() => undefined);
    return payload;
  }

  /**
   * What the renderer's proxy needs to choose variants for a request: running tests and active
   * personalizations with their public paths, plus the segment rules. Small and cached per site
   * version, so the proxy can refresh it every few seconds without touching the database.
   */
  async runtime(siteId: string): Promise<RuntimeConfig> {
    const site = await this.site(siteId);
    const version = await this.siteVersion(siteId);
    const cacheKey = `dlv:rt:${siteId}:${version}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) return JSON.parse(cached) as RuntimeConfig;
    const publicPath = (p: { fullPath: string; locale: string }) => (p.locale === site.defaultLocale ? p.fullPath : `/${p.locale}${p.fullPath === '/' ? '' : p.fullPath}`);
    const [tests, personalizations] = await Promise.all([
      this.system.abTest.findMany({ where: { status: 'RUNNING', page: { siteId, deletedAt: null, publishedVersion: { not: null } } }, include: { page: { select: { fullPath: true, locale: true } } } }),
      this.system.personalization.findMany({ where: { siteId, status: 'ACTIVE', segment: { deletedAt: null }, page: { deletedAt: null, publishedVersion: { not: null } } }, include: { page: { select: { fullPath: true, locale: true } } }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    const segmentIds = [...new Set(personalizations.map((p) => p.segmentId))];
    const segments = segmentIds.length ? await this.system.segment.findMany({ where: { id: { in: segmentIds } }, select: { id: true, rules: true } }) : [];
    const byPage = new Map<string, RuntimeConfig['personalization'][number]>();
    for (const p of personalizations) {
      const entry = byPage.get(p.pageId) ?? { pageId: p.pageId, path: publicPath(p.page), locale: p.page.locale, segmentIds: [] };
      entry.segmentIds.push(p.segmentId);
      byPage.set(p.pageId, entry);
    }
    const config: RuntimeConfig = {
      siteId,
      version,
      experiments: tests.map((t) => ({ id: t.id, pageId: t.pageId, path: publicPath(t.page), locale: t.page.locale, trafficAllocation: t.trafficAllocation, variants: (t.variants as { id: string; weight: number }[]).map((v) => ({ id: v.id, weight: v.weight })) })),
      personalization: [...byPage.values()],
      segments: segments.map((s) => ({ id: s.id, rules: s.rules as RuntimeConfig['segments'][number]['rules'] })),
      redirects: (await this.system.redirect.findMany({ where: { siteId }, select: { fromPath: true, toPath: true, statusCode: true } })).map((r) => ({ from: r.fromPath, to: r.toPath, status: r.statusCode as 301 | 302 | 307 | 308 })),
    };
    await this.redis.set(cacheKey, JSON.stringify(config), 'EX', CACHE_TTL_SEC).catch(() => undefined);
    return config;
  }

  /**
   * `/blog/<slug>`: the collection's live template page with the published entry filled in. Title,
   * description and canonical path are the entry's; a real page at the same path always wins.
   */
  private async entryPage(site: Site, path: string, locale: string) {
    const hit = await this.entryPages.find(site.id, path, locale);
    if (!hit) throw notFound('Page');
    const template = await this.system.page.findFirst({ where: { id: hit.route.templatePageId, siteId: site.id, deletedAt: null, publishedVersion: { not: null } } });
    if (!template?.publishedVersion) throw notFound('Page');
    const snapshot = await this.system.pageVersion.findUnique({ where: { pageId_version: { pageId: template.id, version: template.publishedVersion } } });
    if (!snapshot) throw notFound('Page');
    const content = bindEntry(snapshot.content as unknown as PageContent, hit.entry);
    const seo = { ...(snapshot.seo as Record<string, unknown>), title: hit.entry.title, description: hit.entry.summary ?? (snapshot.seo as { description?: string }).description };
    // Translations of a template don't map entries across locales, so entry pages carry no alternates.
    const page: Page = { ...template, title: hit.entry.title, description: hit.entry.summary ?? template.description, fullPath: path, locale, translationGroupId: null, publishedAt: (hit.entry.publishedAt as Date | null) ?? template.publishedAt };
    return { ...(await this.assemble(site, page, content, seo, false)), entry: entryRef(hit), applied: { experiments: [], segmentId: null } };
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
    const [templates, entries] = await Promise.all([this.entryPages.templatePageIds(siteId), this.entryPages.sitemapEntries(siteId)]);
    const pages = await this.system.page.findMany({
      where: { siteId, deletedAt: null, publishedVersion: { not: null }, id: { notIn: [...templates] } },
      select: { id: true, title: true, fullPath: true, locale: true, parentId: true, position: true, updatedAt: true, publishedAt: true, translationGroupId: true, seo: true },
      orderBy: [{ locale: 'asc' }, { position: 'asc' }, { fullPath: 'asc' }],
    });
    return {
      site: presentSite(site),
      pages: pages
        // The site's 404 page is a template, not a destination.
        .filter((p) => !(p.seo as { noindex?: boolean }).noindex && p.fullPath !== '/404')
        .map((p) => ({ id: p.id, title: p.title, path: p.fullPath, locale: p.locale, parentId: p.parentId, position: p.position, updatedAt: p.publishedAt ?? p.updatedAt, translationGroupId: p.translationGroupId })),
      // Entry pages (sitemap only — they are not menu items).
      entries: entries.map((e) => ({ path: e.path, locale: e.locale, updatedAt: e.updatedAt })),
    };
  }

  private async assemble(site: Site, page: Page, raw: PageContent, seo: Record<string, unknown>, draft: boolean) {
    // Global components are expanded first, so their media, facts and forms load like the page's own.
    const content = await this.withComponents(site.id, raw, draft);
    // Collection lists: cards from published entries; their images load with the page's media.
    const [lists, products, shop, templates] = await Promise.all([
      this.entryPages.lists(site.id, collectListSpecs(content.root), page.locale) as Promise<Record<string, ListItem[]>>,
      this.entryPages.products(site.id, collectProductIds(content.root)),
      hasCart(content.root) ? this.entryPages.shop(site.id) : null,
      // Entry templates are moulds, not menu items.
      this.entryPages.templatePageIds(site.id),
    ]);
    const mediaIds = collectMediaIds(content);
    for (const items of Object.values(lists)) for (const i of items) if (i.mediaId) mediaIds.push(i.mediaId);
    const ogId = typeof seo.ogImageMediaId === 'string' ? seo.ogImageMediaId : undefined;
    if (ogId) mediaIds.push(ogId);
    const factKeys = collectPageFactKeys(content);
    const formIds = collectFormIds(content.root);

    // Ancestors for the breadcrumb (Schema.org BreadcrumbList): "/a/b/c" → "/a", "/a/b".
    const parts = page.fullPath.split('/').filter(Boolean);
    const ancestorPaths = parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
    const [mediaRows, factRows, alternates, nav, formRows, ancestors] = await Promise.all([
      mediaIds.length
        ? this.system.media.findMany({
            where: { id: { in: mediaIds }, siteId: site.id, deletedAt: null, status: 'READY' },
          })
        : [],
      factKeys.length
        ? this.system.fact.findMany({
            where: { tenantId: site.tenantId, key: { in: factKeys }, deletedAt: null },
            select: { key: true, displayValue: true },
          })
        : [],
      page.translationGroupId
        ? this.system.page.findMany({ where: { translationGroupId: page.translationGroupId, siteId: site.id, deletedAt: null, publishedVersion: { not: null } }, select: { locale: true, fullPath: true } })
        : [],
      this.system.page.findMany({
        where: { siteId: site.id, locale: page.locale, parentId: null, deletedAt: null, publishedVersion: { not: null }, fullPath: { notIn: ['/', '/404'] }, id: { notIn: [...templates] } },
        select: { title: true, fullPath: true },
        orderBy: [{ position: 'asc' }, { fullPath: 'asc' }],
        take: 8,
      }),
      formIds.length
        ? this.system.form.findMany({ where: { id: { in: formIds }, siteId: site.id, deletedAt: null } })
        : [],
      ancestorPaths.length
        ? this.system.page.findMany({ where: { siteId: site.id, locale: page.locale, fullPath: { in: ancestorPaths }, deletedAt: null, publishedVersion: { not: null } }, select: { title: true, fullPath: true } })
        : [],
    ]);

    return {
      draft,
      site: presentSite(site),
      page: { id: page.id, title: page.title, description: page.description, locale: page.locale, path: page.fullPath, seo, content, publishedAt: page.publishedAt, version: draft ? page.version : page.publishedVersion },
      alternates: alternates.map((a) => ({ locale: a.locale, path: a.fullPath })),
      nav: nav.map((n) => ({ title: n.title, path: n.fullPath })),
      media: Object.fromEntries(mediaRows.map((m) => [m.id, this.media.present(m)])),
      facts: Object.fromEntries(factRows.map((f) => [f.key, f.displayValue])),
      forms: Object.fromEntries(formRows.map((f) => [f.id, publicForm(f)])),
      lists,
      products,
      shop,
      breadcrumbs: ancestorPaths.flatMap((p) => ancestors.filter((a) => a.fullPath === p).map((a) => ({ title: a.title, path: a.fullPath }))),
    };
  }

  /** Published component trees for live pages; previews show the working copies. */
  private async withComponents(siteId: string, content: PageContent, draft: boolean): Promise<PageContent> {
    const ids = collectComponentIds(content.root);
    if (!ids.length) return content;
    const rows = await this.system.siteComponent.findMany({ where: { id: { in: ids }, siteId, deletedAt: null }, select: { id: true, tree: true, publishedTree: true } });
    const trees: Record<string, BlockNode> = {};
    for (const r of rows) {
      const tree = (draft ? r.tree : r.publishedTree) as BlockNode | null;
      if (tree) trees[r.id] = tree;
    }
    return expandComponents(content, trees);
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

function entryRef(hit: EntryPageHit) {
  return { id: hit.entry.id, collectionId: hit.collectionId, slug: hit.entry.slug, basePath: hit.route.basePath };
}

function presentSite(s: Site) {
  return {
    id: s.id,
    name: s.name,
    host: servedHost(s),
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

/** Form blocks on a page (any depth): their definitions travel with the page. */
function collectFormIds(node: {
  type: string;
  props: Record<string, unknown>;
  children: { type: string; props: Record<string, unknown>; children: unknown[] }[];
}): string[] {
  const out = new Set<string>();
  const walk = (n: typeof node) => {
    if (n.type === 'form' && typeof n.props.formId === 'string' && n.props.formId) out.add(n.props.formId);
    for (const c of n.children) walk(c as typeof node);
  };
  walk(node);
  return [...out];
}
