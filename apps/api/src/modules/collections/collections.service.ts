import { collectionAiSettingsSchema, collectionFieldsSchema, collectionSettingsSchema, diffSchemas, type CollectionAiSettings, type CollectionSettings, type FieldDef } from '@canon/fields';
import { Prisma, type Collection } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, notFound, quotaExceeded } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { TenantsService } from '../tenancy/tenants.service';
import type { CreateCollectionBody, UpdateCollectionBody } from './collections.dto';

/** A collection with its JSON columns parsed — what every consumer actually works with. */
export interface CollectionModel {
  row: Collection;
  fields: FieldDef[];
  settings: CollectionSettings;
  ai: CollectionAiSettings;
}

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly tenants: TenantsService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const db = this.prisma.forTenant({ tenantId });
    const rows = await db.collection.findMany({ where: { tenantId, siteId, deletedAt: null }, orderBy: { name: 'asc' } });
    const counts = await db.entry.groupBy({ by: ['collectionId'], where: { tenantId, deletedAt: null, collectionId: { in: rows.map((r) => r.id) } }, _count: true });
    const byId = new Map(counts.map((c) => [c.collectionId, c._count]));
    return rows.map((r) => ({ ...present(this.model(r)), entryCount: byId.get(r.id) ?? 0 }));
  }

  async get(tenantId: string, siteId: string, id: string): Promise<CollectionModel> {
    const row = await this.prisma.forTenant({ tenantId }).collection.findFirst({ where: { id, siteId, tenantId, deletedAt: null } });
    if (!row) throw notFound('Collection');
    return this.model(row);
  }

  async getById(tenantId: string, id: string): Promise<CollectionModel> {
    const row = await this.prisma.forTenant({ tenantId }).collection.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!row) throw notFound('Collection');
    return this.model(row);
  }

  async detail(tenantId: string, siteId: string, id: string) {
    return present(await this.get(tenantId, siteId, id));
  }

  /** Tolerates rows written before a meta-schema change: invalid stored JSON degrades to defaults, never to a 500. */
  model(row: Collection): CollectionModel {
    const fields = collectionFieldsSchema.safeParse(row.schema);
    return {
      row,
      fields: fields.success ? fields.data : [],
      settings: collectionSettingsSchema.parse((row.settings as object) ?? {}),
      ai: collectionAiSettingsSchema.parse((row.aiSettings as object) ?? {}),
    };
  }

  async create(actor: TenantPrincipal, siteId: string, body: CreateCollectionBody) {
    await this.sites.get(actor.tenantId, siteId);
    await this.assertLimit(actor.tenantId);
    await this.assertRelationTargets(actor.tenantId, siteId, body.fields, null);
    assertSettings(body.fields, body.settings ?? {});
    const row = await this.write(actor, (tx) =>
      tx.collection.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          name: body.name,
          slug: body.slug,
          description: body.description ?? null,
          schema: body.fields as unknown as Prisma.InputJsonValue,
          settings: (body.settings ?? {}) as Prisma.InputJsonValue,
          aiSettings: collectionAiSettingsSchema.parse(body.aiSettings ?? {}) as unknown as Prisma.InputJsonValue,
          isSingleton: body.isSingleton,
        },
      }),
    );
    await this.audit.record({ tenantId: actor.tenantId, action: 'collection.created', entityType: 'Collection', entityId: row.id, changes: { slug: row.slug, fields: body.fields.length } }, actor);
    return present(this.model(row));
  }

  /**
   * Schema changes are checked against existing data: adding/removing fields and lossless type
   * changes go through; a lossy type change on a field that has values needs `force`, because those
   * values will fail validation and be dropped on each entry's next save.
   */
  async update(actor: TenantPrincipal, siteId: string, id: string, body: UpdateCollectionBody) {
    const current = await this.get(actor.tenantId, siteId, id);
    const data: Prisma.CollectionUpdateInput = {};
    let diff: ReturnType<typeof diffSchemas> | null = null;
    if (body.fields) {
      await this.assertRelationTargets(actor.tenantId, siteId, body.fields, id);
      diff = diffSchemas(current.fields, body.fields);
      const lossy = diff.retyped.filter((r) => !r.lossless);
      if (lossy.length && !body.force) {
        const affected = await Promise.all(lossy.map(async (r) => ({ field: r.name, from: r.from, to: r.to, entries: await this.countWithValue(actor.tenantId, id, r.name) })));
        const blocking = affected.filter((a) => a.entries > 0);
        if (blocking.length) throw new ApiError('SCHEMA_CONFLICT', 'Some type changes would invalidate existing values — pass force: true to accept', 409, { fields: blocking });
      }
      data.schema = body.fields as unknown as Prisma.InputJsonValue;
    }
    const fields = body.fields ?? current.fields;
    const settings = body.settings ?? current.settings;
    assertSettings(fields, settings);
    if (body.name !== undefined) data.name = body.name;
    if (body.slug !== undefined) data.slug = body.slug;
    if (body.description !== undefined) data.description = body.description;
    if (body.settings) data.settings = body.settings as Prisma.InputJsonValue;
    if (body.aiSettings) data.aiSettings = body.aiSettings as unknown as Prisma.InputJsonValue;

    const row = await this.write(actor, async (tx) => {
      const r = await tx.collection.update({ where: { id }, data });
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Collection', aggregateId: id, type: 'CollectionUpdated', payload: { siteId, collectionId: id, slug: r.slug } });
      return r;
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'collection.updated', entityType: 'Collection', entityId: id, changes: (diff ?? {}) as unknown as Prisma.InputJsonObject }, actor);
    return { ...present(this.model(row)), diff };
  }

  async remove(actor: TenantPrincipal, siteId: string, id: string, force: boolean): Promise<void> {
    const c = await this.get(actor.tenantId, siteId, id);
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const entries = await db.entry.count({ where: { collectionId: id, deletedAt: null } });
    if (entries > 0 && !force) throw conflict(`The collection has ${entries} entries — pass force=true to delete them too`, { entries });
    const others = await db.collection.findMany({ where: { tenantId: actor.tenantId, siteId, deletedAt: null, NOT: { id } } });
    const referencing = others.filter((o) => this.model(o).fields.some((f) => f.type === 'relation' && f.relation?.collectionId === id));
    if (referencing.length) throw conflict(`Relation fields in ${referencing.map((r) => `"${r.name}"`).join(', ')} point to this collection`, { collections: referencing.map((r) => r.id) });
    const now = new Date();
    await this.write(actor, async (tx) => {
      // Slugs are freed for reuse; soft-deleted rows keep a tombstone suffix.
      await tx.entry.updateMany({ where: { collectionId: id, deletedAt: null }, data: { deletedAt: now, publishedVersion: null } });
      await tx.collection.update({ where: { id }, data: { deletedAt: now, slug: `${c.row.slug}--deleted-${now.getTime()}` } });
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Collection', aggregateId: id, type: 'CollectionDeleted', payload: { siteId, collectionId: id } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'collection.deleted', entityType: 'Collection', entityId: id, changes: { entries } }, actor);
  }

  private async countWithValue(tenantId: string, collectionId: string, field: string): Promise<number> {
    const rows = await this.prisma.rawForTenant({ tenantId }, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM entries WHERE "collectionId" = ${collectionId} AND "deletedAt" IS NULL AND data ? ${field} AND data->${field} <> 'null'::jsonb`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async assertRelationTargets(tenantId: string, siteId: string, fields: readonly FieldDef[], selfId: string | null): Promise<void> {
    const targets = [...new Set(fields.filter((f) => f.type === 'relation').map((f) => f.relation!.collectionId))].filter((t) => t !== selfId);
    if (!targets.length) return;
    const found = await this.prisma.forTenant({ tenantId }).collection.findMany({ where: { id: { in: targets }, siteId, tenantId, deletedAt: null }, select: { id: true } });
    const missing = targets.filter((t) => !found.some((f) => f.id === t));
    if (missing.length) throw badRequest('INVALID_RELATION', 'Relation fields must point to collections of the same site', { missing });
  }

  private async assertLimit(tenantId: string): Promise<void> {
    const tenant = await this.tenants.get(tenantId);
    const limit = this.tenants.limits(tenant).collections;
    if (limit === null) return;
    const count = await this.prisma.forTenant({ tenantId }).collection.count({ where: { tenantId, deletedAt: null } });
    if (count >= limit) throw quotaExceeded(`Your ${tenant.plan} plan allows ${limit} collections`, { resource: 'collections', limit });
  }

  private write<T>(actor: TenantPrincipal, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, fn).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError('SLUG_TAKEN', 'Another collection on this site already uses this slug', 409);
      throw err;
    });
  }
}

function assertSettings(fields: readonly FieldDef[], settings: CollectionSettings): void {
  for (const key of ['titleField', 'slugField'] as const) {
    const name = settings[key];
    if (name && !fields.some((f) => f.name === name && (f.type === 'text' || f.type === 'textarea'))) throw badRequest('INVALID_SETTINGS', `${key} must name a text field`);
  }
}

export function present(c: CollectionModel) {
  const r = c.row;
  return { id: r.id, siteId: r.siteId, name: r.name, slug: r.slug, description: r.description, fields: c.fields, settings: c.settings, aiSettings: c.ai, isSingleton: r.isSingleton, createdAt: r.createdAt, updatedAt: r.updatedAt };
}
