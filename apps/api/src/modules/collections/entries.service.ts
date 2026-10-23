import { subject } from '@casl/ability';
import { collectRelations, entryTitle, normalizeTag, slugify, titleFieldOf, validateEntryData, type EntryData, type FieldDef } from '@canon/fields';
import { Prisma, type Entry } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, forbidden, notFound, quotaExceeded } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { TenantsService } from '../tenancy/tenants.service';
import { CollectionsService, type CollectionModel } from './collections.service';
import type { CreateEntryBody, ListEntriesQuery, UpdateEntryBody } from './collections.dto';
import { EnrichmentQueue } from './enrichment.queue';

type Tx = Prisma.TransactionClient;

/** Slug given to entries created without a title ("New entry" in the admin). */
const PLACEHOLDER_SLUG = /^entry(-\d+)?$/;

/** Search falls back from full-text to a title substring; capped so a broad query can't scan the world. */
const SEARCH_CANDIDATES = 2_000;

export interface WriteOptions {
  /** Import and AI flows set this so the ledger/audit can tell machine writes apart. */
  source?: 'editor' | 'import' | 'api';
  /** Skip enrichment scheduling (imports schedule once, in bulk). */
  skipEnrichment?: boolean;
}

@Injectable()
export class EntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionsService,
    private readonly sites: SitesService,
    private readonly tenants: TenantsService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    private readonly enrichment: EnrichmentQueue,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────────

  async list(tenantId: string, siteId: string, collectionId: string, q: ListEntriesQuery) {
    await this.collections.get(tenantId, siteId, collectionId);
    const db = this.prisma.forTenant({ tenantId });
    let ids: string[] | undefined;
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await this.prisma.rawForTenant({ tenantId }, (tx) =>
        tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM entries
          WHERE "collectionId" = ${collectionId} AND "deletedAt" IS NULL
            AND ("searchVector" @@ websearch_to_tsquery('simple', ${q.q}) OR title ILIKE ${like} OR slug ILIKE ${like})
          LIMIT ${SEARCH_CANDIDATES}`,
      );
      ids = rows.map((r) => r.id);
    }
    const where: Prisma.EntryWhereInput = {
      tenantId,
      collectionId,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.locale ? { locale: q.locale } : {}),
      ...(q.tag ? { tags: { has: normalizeTag(q.tag) } } : {}),
      ...(ids ? { id: { in: ids } } : {}),
    };
    const orderBy: Prisma.EntryOrderByWithRelationInput =
      q.sort === 'title' ? { title: q.order } : q.sort === 'created' ? { createdAt: q.order } : q.sort === 'quality' ? { qualityScore: { sort: q.order, nulls: 'last' } } : { updatedAt: q.order };
    const [rows, total, tagRows] = await Promise.all([
      db.entry.findMany({ where, orderBy: [orderBy, { id: 'asc' }], skip: q.offset, take: q.limit }),
      db.entry.count({ where }),
      this.prisma.rawForTenant({ tenantId }, (tx) =>
        tx.$queryRaw<{ tag: string; n: bigint }[]>`SELECT unnest(tags) AS tag, count(*)::bigint AS n FROM entries WHERE "collectionId" = ${collectionId} AND "deletedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50`,
      ),
    ]);
    return { items: rows.map(presentSummary), total, tags: tagRows.map((t) => ({ tag: t.tag, count: Number(t.n) })) };
  }

  async get(tenantId: string, collectionId: string, entryId: string): Promise<Entry> {
    const e = await this.prisma.forTenant({ tenantId }).entry.findFirst({ where: { id: entryId, collectionId, tenantId, deletedAt: null } });
    if (!e) throw notFound('Entry');
    return e;
  }

  /** Full entry plus resolved relations (one level) and reverse references ("used by"). */
  async detail(tenantId: string, siteId: string, collectionId: string, entryId: string) {
    const c = await this.collections.get(tenantId, siteId, collectionId);
    const e = await this.get(tenantId, collectionId, entryId);
    const db = this.prisma.forTenant({ tenantId });
    const relIds = collectRelations(c.fields, e.data as EntryData).map((r) => r.targetId);
    const [targets, incoming, versions] = await Promise.all([
      relIds.length ? db.entry.findMany({ where: { id: { in: relIds }, deletedAt: null }, select: { id: true, title: true, slug: true, collectionId: true, status: true } }) : [],
      db.entryRelation.findMany({ where: { toEntryId: entryId, from: { deletedAt: null } }, select: { field: true, from: { select: { id: true, title: true, collectionId: true, collection: { select: { name: true } } } } }, take: 50 }),
      db.entryVersion.count({ where: { entryId } }),
    ]);
    return {
      ...presentSummary(e),
      collectionId: e.collectionId,
      data: e.data,
      aiMeta: e.aiMeta,
      related: Object.fromEntries(targets.map((t) => [t.id, t])),
      referencedBy: incoming.map((r) => ({ field: r.field, entryId: r.from.id, title: r.from.title, collectionId: r.from.collectionId, collectionName: r.from.collection.name })),
      versionCount: versions,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  async create(actor: TenantPrincipal, siteId: string, collectionId: string, body: CreateEntryBody, opts: WriteOptions = {}) {
    const c = await this.collections.get(actor.tenantId, siteId, collectionId);
    const site = await this.sites.get(actor.tenantId, siteId);
    const locale = body.locale ?? site.defaultLocale;
    if (!site.locales.includes(locale)) throw badRequest('INVALID_LOCALE', `Site does not have locale "${locale}"`);
    await this.assertLimit(actor.tenantId);
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    if (c.row.isSingleton && (await db.entry.count({ where: { collectionId, locale, deletedAt: null } })) > 0) throw conflict('This collection holds a single entry per locale');

    const data = this.validated(c, body.data, 'draft');
    await this.assertRelations(actor.tenantId, c, data);
    await this.assertUnique(actor.tenantId, c, data, locale, null);
    const title = entryTitle(c.fields, c.settings, data, '');
    const slugSource = (c.settings.slugField && typeof data[c.settings.slugField] === 'string' ? (data[c.settings.slugField] as string) : '') || title;
    const slug = body.slug ?? (await this.freeSlug(actor.tenantId, collectionId, locale, slugify(slugSource || 'entry')));

    const entry = await this.write(actor, async (tx) => {
      const e = await tx.entry.create({
        data: {
          tenantId: actor.tenantId,
          collectionId,
          data: data as Prisma.InputJsonValue,
          slug,
          title,
          locale,
          tags: normalizeTags(body.tags ?? []),
          createdById: actor.userId ?? null,
          updatedById: actor.userId ?? null,
        },
      });
      await this.syncRelations(tx, e, c.fields, data);
      await this.outbox.enqueue(tx, entryEvent(e, siteId, 'EntryChanged', { version: 1 }));
      return e;
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'entry.created', entityType: 'Entry', entityId: entry.id, changes: { collectionId, slug, source: opts.source ?? 'editor' } }, actor);
    if (!opts.skipEnrichment) await this.enrichment.schedule(actor.tenantId, entry.id, c.ai);
    return entry;
  }

  async update(actor: TenantPrincipal, ability: AppAbility | null, siteId: string, collectionId: string, entryId: string, body: UpdateEntryBody, opts: WriteOptions = {}) {
    const c = await this.collections.get(actor.tenantId, siteId, collectionId);
    const e = await this.get(actor.tenantId, collectionId, entryId);
    if (ability) assertCan(ability, 'update', e);
    const patch: Prisma.EntryUncheckedUpdateManyInput = { version: { increment: 1 }, updatedById: actor.userId ?? null };
    let data: EntryData | null = null;
    if (body.data !== undefined) {
      data = this.validated(c, body.data, 'draft');
      await this.assertRelations(actor.tenantId, c, data);
      await this.assertUnique(actor.tenantId, c, data, e.locale, e.id);
      patch.data = data as Prisma.InputJsonValue;
      patch.title = entryTitle(c.fields, c.settings, data, '');
    }
    if (body.slug !== undefined && body.slug !== e.slug) patch.slug = body.slug;
    else if (PLACEHOLDER_SLUG.test(e.slug) && e.publishedVersion === null && typeof patch.title === 'string' && patch.title) {
      // "New entry" starts empty with a placeholder slug; it follows the title until first publish.
      patch.slug = await this.freeSlug(actor.tenantId, collectionId, e.locale, slugify(patch.title));
    }
    if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
    if (body.status !== undefined) {
      if (body.status === 'ARCHIVED' && e.publishedVersion) throw conflict('Unpublish the entry before archiving it');
      patch.status = body.status;
    }

    await this.write(actor, async (tx) => {
      // Compare-and-swap on version, exactly like pages: stale tabs and concurrent imports can't clobber.
      const res = await tx.entry.updateMany({ where: { id: entryId, version: body.expectedVersion, deletedAt: null }, data: patch });
      if (res.count === 0) throw new ApiError('VERSION_CONFLICT', 'The entry was changed by someone else — reload to get the latest version', 409, { currentVersion: e.version });
      if (data) {
        await this.syncRelations(tx, e, c.fields, data);
        await this.outbox.enqueue(tx, entryEvent(e, siteId, 'EntryChanged', { version: e.version + 1 }));
      }
    });
    if (data && !opts.skipEnrichment) await this.enrichment.schedule(actor.tenantId, entryId, c.ai);
    return this.detail(actor.tenantId, siteId, collectionId, entryId);
  }

  async remove(actor: TenantPrincipal, ability: AppAbility, siteId: string, collectionId: string, entryId: string, force: boolean): Promise<void> {
    await this.collections.get(actor.tenantId, siteId, collectionId);
    const e = await this.get(actor.tenantId, collectionId, entryId);
    assertCan(ability, 'delete', e);
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const refs = await db.entryRelation.count({ where: { toEntryId: entryId, from: { deletedAt: null } } });
    if (refs > 0 && !force) throw new ApiError('ENTRY_IN_USE', `${refs} other entr${refs === 1 ? 'y references' : 'ies reference'} this one — pass force=true to delete anyway`, 409, { references: refs });
    await this.write(actor, async (tx) => {
      await tx.entry.update({ where: { id: entryId }, data: { deletedAt: new Date(), publishedVersion: null } });
      await tx.entryRelation.deleteMany({ where: { fromEntryId: entryId } });
      if (e.publishedVersion) await this.outbox.enqueue(tx, entryEvent(e, siteId, 'EntryUnpublished', { reason: 'deleted' }));
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'entry.deleted', entityType: 'Entry', entityId: entryId, changes: { slug: e.slug, force } }, actor);
  }

  /** Publish validates against the *current* schema with required fields enforced, then snapshots. */
  async publish(actor: TenantPrincipal, ability: AppAbility | null, siteId: string, collectionId: string, entryId: string, comment?: string) {
    const c = await this.collections.get(actor.tenantId, siteId, collectionId);
    const e = await this.get(actor.tenantId, collectionId, entryId);
    if (ability) assertCan(ability, 'publish', e);
    const data = this.validated(c, e.data, 'publish');
    await this.write(actor, async (tx) => {
      await tx.entryVersion.upsert({
        where: { entryId_version: { entryId, version: e.version } },
        create: { tenantId: e.tenantId, entryId, version: e.version, data: data as Prisma.InputJsonValue, slug: e.slug, title: e.title, tags: e.tags, summary: e.summary, comment: comment ?? 'Published', createdById: actor.userId ?? null },
        update: { comment: comment ?? 'Published', slug: e.slug, title: e.title, tags: e.tags, summary: e.summary },
      });
      await tx.entry.update({ where: { id: entryId }, data: { status: 'PUBLISHED', publishedVersion: e.version, publishedAt: new Date() } });
      await this.outbox.enqueue(tx, entryEvent(e, siteId, 'EntryPublished', { version: e.version }));
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'entry.published', entityType: 'Entry', entityId: entryId, changes: { version: e.version } }, actor);
    return this.detail(actor.tenantId, siteId, collectionId, entryId);
  }

  async unpublish(actor: TenantPrincipal, ability: AppAbility | null, siteId: string, collectionId: string, entryId: string) {
    await this.collections.get(actor.tenantId, siteId, collectionId);
    const e = await this.get(actor.tenantId, collectionId, entryId);
    if (ability) assertCan(ability, 'publish', e);
    if (e.publishedVersion) {
      await this.write(actor, async (tx) => {
        await tx.entry.update({ where: { id: entryId }, data: { status: 'DRAFT', publishedVersion: null } });
        await this.outbox.enqueue(tx, entryEvent(e, siteId, 'EntryUnpublished', { reason: 'unpublished' }));
      });
      await this.audit.record({ tenantId: actor.tenantId, action: 'entry.unpublished', entityType: 'Entry', entityId: entryId }, actor);
    }
    return this.detail(actor.tenantId, siteId, collectionId, entryId);
  }

  async versions(tenantId: string, siteId: string, collectionId: string, entryId: string) {
    await this.collections.get(tenantId, siteId, collectionId);
    const e = await this.get(tenantId, collectionId, entryId);
    const rows = await this.prisma.forTenant({ tenantId }).entryVersion.findMany({
      where: { entryId },
      orderBy: { version: 'desc' },
      take: 100,
      select: { version: true, title: true, comment: true, createdAt: true, createdBy: { select: { name: true } } },
    });
    return rows.map((v) => ({ ...v, isPublished: v.version === e.publishedVersion }));
  }

  /** Restoring copies the snapshot into the draft (new draft version); the live version is untouched. */
  async restore(actor: TenantPrincipal, ability: AppAbility, siteId: string, collectionId: string, entryId: string, version: number) {
    const e = await this.get(actor.tenantId, collectionId, entryId);
    const v = await this.prisma.forTenant({ tenantId: actor.tenantId }).entryVersion.findUnique({ where: { entryId_version: { entryId, version } } });
    if (!v) throw notFound('Version');
    return this.update(actor, ability, siteId, collectionId, entryId, { expectedVersion: e.version, data: v.data as EntryData, tags: v.tags });
  }

  async duplicate(actor: TenantPrincipal, siteId: string, collectionId: string, entryId: string) {
    const c = await this.collections.get(actor.tenantId, siteId, collectionId);
    const e = await this.get(actor.tenantId, collectionId, entryId);
    const data = { ...(e.data as EntryData) };
    // Unique values can't be copied verbatim; the copy starts without them.
    for (const f of c.fields) if (f.unique) delete data[f.name];
    const t = titleFieldOf(c.fields, c.settings);
    if (t && typeof data[t.name] === 'string') data[t.name] = `${data[t.name] as string} (copy)`.slice(0, t.max ?? 500);
    return this.create(actor, siteId, collectionId, { data, locale: e.locale, tags: e.tags });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  validated(c: CollectionModel, input: unknown, mode: 'draft' | 'publish'): EntryData {
    const res = validateEntryData(c.fields, input, mode);
    if (!res.ok) throw new ApiError('INVALID_ENTRY', mode === 'publish' ? 'The entry is not ready to publish' : 'The entry has invalid fields', 422, { issues: res.issues });
    return res.data;
  }

  private async assertRelations(tenantId: string, c: CollectionModel, data: EntryData): Promise<void> {
    const byField = new Map<string, string[]>();
    for (const r of collectRelations(c.fields, data)) byField.set(r.field, [...(byField.get(r.field) ?? []), r.targetId]);
    for (const [field, ids] of byField) {
      const target = c.fields.find((f) => f.name === field)!.relation!.collectionId;
      const found = await this.prisma.forTenant({ tenantId }).entry.count({ where: { id: { in: ids }, collectionId: target, tenantId, deletedAt: null } });
      if (found !== new Set(ids).size) throw new ApiError('INVALID_ENTRY', 'Some related entries do not exist', 422, { issues: [{ field, message: 'Related entry not found (deleted or in another collection)' }] });
    }
  }

  private async assertUnique(tenantId: string, c: CollectionModel, data: EntryData, locale: string, selfId: string | null): Promise<void> {
    for (const f of c.fields.filter((x) => x.unique)) {
      const v = data[f.name];
      if (v === undefined) continue;
      const clash = await this.prisma.forTenant({ tenantId }).entry.findFirst({
        where: { collectionId: c.row.id, locale, deletedAt: null, ...(selfId ? { NOT: { id: selfId } } : {}), data: { path: [f.name], equals: v as Prisma.InputJsonValue } },
        select: { id: true, title: true },
      });
      if (clash) throw new ApiError('INVALID_ENTRY', `${f.label} must be unique`, 422, { issues: [{ field: f.name, message: `Already used by “${clash.title || clash.id}”` }], conflictId: clash.id });
    }
  }

  async freeSlug(tenantId: string, collectionId: string, locale: string, base: string): Promise<string> {
    const taken = await this.prisma.forTenant({ tenantId }).entry.findMany({ where: { collectionId, locale, deletedAt: null, slug: { startsWith: base } }, select: { slug: true } });
    const set = new Set(taken.map((t) => t.slug));
    if (!set.has(base)) return base;
    for (let i = 2; i < 10_000; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
    return `${base}-${Date.now()}`;
  }

  private async syncRelations(tx: Tx, e: Pick<Entry, 'id' | 'tenantId'>, fields: readonly FieldDef[], data: EntryData): Promise<void> {
    await tx.entryRelation.deleteMany({ where: { fromEntryId: e.id } });
    const rels = collectRelations(fields, data);
    if (rels.length) await tx.entryRelation.createMany({ data: rels.map((r) => ({ tenantId: e.tenantId, fromEntryId: e.id, field: r.field, toEntryId: r.targetId, position: r.position })) });
  }

  private async assertLimit(tenantId: string): Promise<void> {
    const tenant = await this.tenants.get(tenantId);
    const limit = this.tenants.limits(tenant).entries;
    if (limit === null) return;
    const count = await this.prisma.forTenant({ tenantId }).entry.count({ where: { tenantId, deletedAt: null } });
    if (count >= limit) throw quotaExceeded(`Your ${tenant.plan} plan allows ${limit} entries`, { resource: 'entries', limit });
  }

  private write<T>(actor: TenantPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, fn).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError('SLUG_TAKEN', 'Another entry in this collection already uses this slug in this locale', 409);
      throw err;
    });
  }
}

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, 30);
}

function assertCan(ability: AppAbility, action: 'update' | 'delete' | 'publish', e: Entry): void {
  if (!ability.can(action, subject('Entry', { tenantId: e.tenantId, createdById: e.createdById }))) {
    throw forbidden(action === 'publish' ? 'Your role cannot publish entries' : `Not allowed to ${action} this entry`);
  }
}

function entryEvent(e: Pick<Entry, 'tenantId' | 'id' | 'collectionId' | 'slug' | 'locale'>, siteId: string, type: string, extra: Prisma.InputJsonObject) {
  return { tenantId: e.tenantId, aggregateType: 'Entry', aggregateId: e.id, type, payload: { siteId, collectionId: e.collectionId, entryId: e.id, slug: e.slug, locale: e.locale, ...extra } };
}

export function presentSummary(e: Entry) {
  const meta = (e.aiMeta ?? {}) as { quality?: { score?: number; issues?: string[] }; duplicates?: unknown[] };
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    status: e.status,
    locale: e.locale,
    tags: e.tags,
    summary: e.summary,
    qualityScore: e.qualityScore,
    qualityIssues: meta.quality?.issues ?? [],
    version: e.version,
    publishedVersion: e.publishedVersion,
    hasUnpublishedChanges: e.publishedVersion !== null && e.publishedVersion !== e.version,
    aiGenerated: e.aiGenerated,
    createdById: e.createdById,
    publishedAt: e.publishedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}
