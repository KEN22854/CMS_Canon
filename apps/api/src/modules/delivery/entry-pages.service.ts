import { entryPath, listItemOf, toMinor, type BoundEntry, type ListItem, type ListSpec, type ShopConfig, type ShopProduct } from '@canon/blocks';
import { collectionFieldsSchema, collectionSettingsSchema, type CollectionCommerce, type CollectionRoute, type FieldDef } from '@canon/fields';
import type { Collection, Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';

/** Upper bound of entry pages in one sitemap (the 50k sitemap limit is shared with pages). */
const SITEMAP_ENTRIES = 5_000;

interface RoutedCollection {
  row: Collection;
  fields: FieldDef[];
  route: CollectionRoute | null;
  commerce: CollectionCommerce | null;
}

export interface EntryPageHit {
  collectionId: string;
  route: CollectionRoute;
  entry: BoundEntry & { id: string; locale: string; updatedAt: Date };
}

/**
 * CMS 2.0 read side: entry pages (`/blog/<slug>` rendered with a template page) and the cards of
 * Collection list blocks. Like the rest of delivery it runs on the system role, so every query is
 * pinned to a resolved siteId and reads only published snapshots (entry_versions at
 * publishedVersion) — a draft entry never reaches a visitor.
 */
@Injectable()
export class EntryPagesService {
  constructor(private readonly system: SystemPrismaService) {}

  /** The published entry behind `path`, when a collection of the site routes its parent path. */
  async find(siteId: string, path: string, locale: string): Promise<EntryPageHit | null> {
    const cut = path.lastIndexOf('/');
    if (cut <= 0) return null;
    const basePath = path.slice(0, cut);
    const slug = path.slice(cut + 1);
    const c = (await this.routed(siteId)).find((x) => x.route?.basePath === basePath);
    if (!c?.route || !slug) return null;
    // The published snapshot's slug addresses the entry (a renamed draft keeps its old URL until published).
    const rows = await this.system.entry.findMany({
      where: { collectionId: c.row.id, locale, deletedAt: null, publishedVersion: { not: null }, versions: { some: { slug } } },
      select: { id: true, publishedVersion: true, publishedAt: true, locale: true, updatedAt: true },
      take: 5,
    });
    for (const r of rows) {
      const v = await this.system.entryVersion.findUnique({ where: { entryId_version: { entryId: r.id, version: r.publishedVersion! } } });
      if (v?.slug === slug) {
        return { collectionId: c.row.id, route: c.route, entry: { id: r.id, title: v.title, slug: v.slug, summary: v.summary, publishedAt: r.publishedAt, data: v.data as Record<string, unknown>, locale: r.locale, updatedAt: r.updatedAt } };
      }
    }
    return null;
  }

  /** Pages used as entry templates: not destinations themselves (raw tokens), so delivery hides them. */
  async templatePageIds(siteId: string): Promise<Set<string>> {
    return new Set((await this.routed(siteId)).flatMap((c) => (c.route ? [c.route.templatePageId] : [])));
  }

  /** Cards for every Collection list block of a page, by block id. Unknown collections give no cards. */
  async lists(siteId: string, specs: readonly ListSpec[], locale: string): Promise<Record<string, ListItem[]>> {
    if (!specs.length) return {};
    const collections = await this.routed(siteId);
    const out: Record<string, ListItem[]> = {};
    for (const spec of specs.slice(0, 10)) {
      const c = collections.find((x) => x.row.slug === spec.collection);
      if (!c) {
        out[spec.blockId] = [];
        continue;
      }
      const where: Prisma.EntryWhereInput = { collectionId: c.row.id, locale, deletedAt: null, publishedVersion: { not: null }, ...(spec.tag ? { tags: { has: spec.tag } } : {}) };
      const rows = await this.system.entry.findMany({
        where,
        orderBy: spec.sort === 'title' ? [{ title: 'asc' }, { id: 'asc' }] : [{ publishedAt: spec.sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }],
        take: spec.limit,
        select: { id: true, publishedVersion: true, publishedAt: true },
      });
      const versions = rows.length
        ? await this.system.entryVersion.findMany({ where: { OR: rows.map((r) => ({ entryId: r.id, version: r.publishedVersion! })) }, select: { entryId: true, slug: true, title: true, summary: true, data: true } })
        : [];
      const byId = new Map(versions.map((v) => [v.entryId, v]));
      out[spec.blockId] = rows.flatMap((r) => {
        const v = byId.get(r.id);
        if (!v) return [];
        const e = { id: r.id, title: v.title, slug: v.slug, summary: v.summary, publishedAt: r.publishedAt, data: v.data as Record<string, unknown> };
        return [listItemOf(e, c.fields, spec, c.route ? entryPath(c.route.basePath, v.slug) : null)];
      });
    }
    return out;
  }

  /** What Buy blocks show: title, price and stock of published products of this site's shops. */
  async products(siteId: string, ids: readonly string[]): Promise<Record<string, ShopProduct>> {
    if (!ids.length) return {};
    const shops = (await this.routed(siteId)).filter((c) => c.commerce);
    if (!shops.length) return {};
    const rows = await this.system.entry.findMany({ where: { id: { in: [...ids] }, collectionId: { in: shops.map((s) => s.row.id) }, deletedAt: null, publishedVersion: { not: null } }, select: { id: true, collectionId: true, publishedVersion: true } });
    if (!rows.length) return {};
    const versions = await this.system.entryVersion.findMany({ where: { OR: rows.map((r) => ({ entryId: r.id, version: r.publishedVersion! })) }, select: { entryId: true, slug: true, title: true, data: true } });
    const out: Record<string, ShopProduct> = {};
    for (const r of rows) {
      const v = versions.find((x) => x.entryId === r.id);
      const shop = shops.find((s) => s.row.id === r.collectionId)!.commerce!;
      const data = (v?.data ?? {}) as Record<string, unknown>;
      const price = data[shop.priceField];
      if (!v || typeof price !== 'number' || price < 0) continue;
      const raw = shop.stockField ? data[shop.stockField] : undefined;
      const stock = typeof raw === 'number' ? Math.max(0, Math.floor(raw)) : null;
      out[r.id] = { id: r.id, title: v.title, slug: v.slug, price: toMinor(price), currency: shop.currency, stock, available: stock === null || stock > 0 };
    }
    return out;
  }

  /** The site's shop for a page with a Cart block (the first collection with commerce settings). */
  async shop(siteId: string): Promise<ShopConfig | null> {
    const c = (await this.routed(siteId)).find((x) => x.commerce);
    return c?.commerce ? { collectionId: c.row.id, currency: c.commerce.currency, paymentMethods: c.commerce.paymentMethods } : null;
  }

  /** Entry pages for the sitemap: collections whose template page is live. */
  async sitemapEntries(siteId: string): Promise<{ path: string; locale: string; updatedAt: Date }[]> {
    const routed = (await this.routed(siteId)).filter((c) => c.route);
    if (!routed.length) return [];
    const liveTemplates = await this.system.page.findMany({ where: { siteId, id: { in: routed.map((c) => c.route!.templatePageId) }, deletedAt: null, publishedVersion: { not: null } }, select: { id: true } });
    const live = new Set(liveTemplates.map((p) => p.id));
    const out: { path: string; locale: string; updatedAt: Date }[] = [];
    for (const c of routed.filter((x) => live.has(x.route!.templatePageId))) {
      const rows = await this.system.entry.findMany({
        where: { collectionId: c.row.id, deletedAt: null, publishedVersion: { not: null } },
        select: { id: true, locale: true, publishedVersion: true, publishedAt: true, updatedAt: true },
        orderBy: { publishedAt: 'desc' },
        take: SITEMAP_ENTRIES - out.length,
      });
      if (!rows.length) continue;
      const versions = await this.system.entryVersion.findMany({ where: { OR: rows.map((r) => ({ entryId: r.id, version: r.publishedVersion! })) }, select: { entryId: true, slug: true } });
      const slugOf = new Map(versions.map((v) => [v.entryId, v.slug]));
      for (const r of rows) {
        const slug = slugOf.get(r.id);
        if (slug) out.push({ path: entryPath(c.route!.basePath, slug), locale: r.locale, updatedAt: r.publishedAt ?? r.updatedAt });
      }
      if (out.length >= SITEMAP_ENTRIES) break;
    }
    return out;
  }

  private async routed(siteId: string): Promise<RoutedCollection[]> {
    const rows = await this.system.collection.findMany({ where: { siteId, deletedAt: null } });
    return rows.map((row) => {
      const settings = collectionSettingsSchema.safeParse(row.settings ?? {});
      const fields = collectionFieldsSchema.safeParse(row.schema);
      return { row, fields: fields.success ? fields.data : [], route: settings.success ? (settings.data.route ?? null) : null, commerce: settings.success ? (settings.data.commerce ?? null) : null };
    });
  }
}
