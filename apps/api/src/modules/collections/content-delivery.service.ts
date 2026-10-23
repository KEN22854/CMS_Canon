import { collectRelations, type EntryData } from '@canon/fields';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { notFound } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { LOCALE_RE } from '../sites/sites.dto';
import { CollectionsService, type CollectionModel } from './collections.service';

const CACHE_TTL_SEC = 300;

export const contentQuery = z.object({
  locale: z.string().regex(LOCALE_RE).optional(),
  tag: z.string().trim().max(40).optional(),
  sort: z.enum(['published', 'title']).default('published'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  /** Resolve relation fields to the related entries' published title/slug (one level). */
  expand: z.stringbool().default(false),
});
export type ContentQuery = z.infer<typeof contentQuery>;

interface PublishedRow {
  id: string;
  slug: string;
  title: string;
  tags: string[];
  summary: string | null;
  locale: string;
  publishedAt: Date | null;
  data: EntryData;
}

/**
 * Headless read API (API keys with content:read, or signed-in users). Only *published snapshots*
 * are visible — entry_versions at Entry.publishedVersion — so a draft edit or a draft AI summary
 * never reaches a consumer. Responses are cached under the site's delivery version, which every
 * publish/unpublish/schema change bumps (DeliveryService listens to the same outbox events).
 */
@Injectable()
export class ContentDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async collectionsOf(tenantId: string, siteId: string) {
    const list = await this.collections.list(tenantId, siteId);
    return list.map((c) => ({ slug: c.slug, name: c.name, description: c.description, fields: c.fields.map((f) => ({ name: f.name, label: f.label, type: f.type, multiple: f.multiple, required: f.required })) }));
  }

  async entries(tenantId: string, siteId: string, collectionSlug: string, q: ContentQuery) {
    return this.cached(tenantId, siteId, `list:${collectionSlug}:${JSON.stringify(q)}`, async () => {
      const c = await this.bySlug(tenantId, siteId, collectionSlug);
      const where = { collectionId: c.row.id, deletedAt: null, publishedVersion: { not: null }, ...(q.locale ? { locale: q.locale } : {}), ...(q.tag ? { tags: { has: q.tag } } : {}) };
      const db = this.prisma.forTenant({ tenantId });
      const [rows, total] = await Promise.all([
        db.entry.findMany({ where, orderBy: q.sort === 'title' ? { title: q.order } : { publishedAt: q.order }, skip: q.offset, take: q.limit, select: { id: true, publishedVersion: true, locale: true, publishedAt: true } }),
        db.entry.count({ where }),
      ]);
      const items = await this.snapshots(tenantId, rows);
      return { collection: c.row.slug, total, limit: q.limit, offset: q.offset, items: q.expand ? await this.expand(tenantId, c, items) : items };
    });
  }

  async entry(tenantId: string, siteId: string, collectionSlug: string, entrySlug: string, q: Pick<ContentQuery, 'locale' | 'expand'>) {
    return this.cached(tenantId, siteId, `one:${collectionSlug}:${entrySlug}:${q.locale ?? ''}:${q.expand}`, async () => {
      const c = await this.bySlug(tenantId, siteId, collectionSlug);
      const row = await this.prisma.forTenant({ tenantId }).entry.findFirst({
        // The live slug may differ from the published one; consumers address the published slug.
        where: { collectionId: c.row.id, deletedAt: null, publishedVersion: { not: null }, ...(q.locale ? { locale: q.locale } : {}), versions: { some: { slug: entrySlug } } },
        select: { id: true, publishedVersion: true, locale: true, publishedAt: true },
      });
      const [item] = row ? await this.snapshots(tenantId, [row]) : [];
      if (!item || item.slug !== entrySlug) throw notFound('Entry');
      return q.expand ? (await this.expand(tenantId, c, [item]))[0] : item;
    });
  }

  private async bySlug(tenantId: string, siteId: string, slug: string): Promise<CollectionModel> {
    const row = await this.prisma.forTenant({ tenantId }).collection.findFirst({ where: { tenantId, siteId, slug, deletedAt: null } });
    if (!row) throw notFound('Collection');
    return this.collections.model(row);
  }

  private async snapshots(tenantId: string, rows: { id: string; publishedVersion: number | null; locale: string; publishedAt: Date | null }[]): Promise<PublishedRow[]> {
    if (!rows.length) return [];
    const versions = await this.prisma.forTenant({ tenantId }).entryVersion.findMany({
      where: { OR: rows.map((r) => ({ entryId: r.id, version: r.publishedVersion! })) },
      select: { entryId: true, slug: true, title: true, tags: true, summary: true, data: true },
    });
    const byId = new Map(versions.map((v) => [v.entryId, v]));
    return rows.flatMap((r) => {
      const v = byId.get(r.id);
      return v ? [{ id: r.id, slug: v.slug, title: v.title, tags: v.tags, summary: v.summary, locale: r.locale, publishedAt: r.publishedAt, data: v.data as EntryData }] : [];
    });
  }

  /** Related entries appear only if they are published themselves; drafts resolve to null. */
  private async expand(tenantId: string, c: CollectionModel, items: PublishedRow[]) {
    const ids = [...new Set(items.flatMap((i) => collectRelations(c.fields, i.data).map((r) => r.targetId)))];
    if (!ids.length) return items;
    const targets = await this.prisma.forTenant({ tenantId }).entry.findMany({ where: { id: { in: ids }, deletedAt: null, publishedVersion: { not: null } }, select: { id: true, publishedVersion: true, locale: true, publishedAt: true } });
    const snap = new Map((await this.snapshots(tenantId, targets)).map((s) => [s.id, { id: s.id, slug: s.slug, title: s.title }]));
    return items.map((i) => {
      const data = { ...i.data };
      for (const f of c.fields.filter((x) => x.type === 'relation')) {
        const v = data[f.name];
        if (Array.isArray(v)) data[f.name] = v.map((id) => snap.get(id as string) ?? null).filter(Boolean);
        else if (typeof v === 'string') data[f.name] = snap.get(v) ?? null;
      }
      return { ...i, data };
    });
  }

  // tenantId is part of the key: a cache hit must never bypass the tenant check done by load().
  private async cached<T>(tenantId: string, siteId: string, key: string, load: () => Promise<T>): Promise<T> {
    const ver = (await this.redis.get(`dlv:ver:${siteId}`).catch(() => null)) ?? '0';
    const k = `cnt:${tenantId}:${siteId}:${ver}:${key}`;
    const hit = await this.redis.get(k).catch(() => null);
    if (hit) return JSON.parse(hit) as T;
    const value = await load();
    await this.redis.set(k, JSON.stringify(value), 'EX', CACHE_TTL_SEC).catch(() => undefined);
    return value;
  }
}
