import type { InlineNode } from '@canon/blocks';
import { Prisma, type Fact } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EntriesService } from '../collections/entries.service';
import { PagesService } from '../pages/pages.service';
import type { CreateFactBody, UpdateFactBody } from './canon.dto';
import { formatFactValue, type FactValueType } from './fact-values';
import { MentionsService, parseStoredPath } from './mentions.service';
import { ContentTargets, replaceSpan, withField, type TargetType } from './targets';

export interface EntityRef {
  type: TargetType;
  id: string;
}

@Injectable()
export class FactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mentions: MentionsService,
    private readonly targets: ContentTargets,
    private readonly pages: PagesService,
    private readonly entries: EntriesService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, q: { siteId?: string; q?: string; status?: 'ACTIVE' | 'DISPUTED' | 'DEPRECATED' }) {
    const db = this.prisma.forTenant({ tenantId });
    const rows = await db.fact.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.siteId ? { OR: [{ siteId: q.siteId }, { siteId: null }] } : {}),
        ...(q.q ? { AND: [{ OR: [{ key: { contains: q.q, mode: 'insensitive' } }, { predicate: { contains: q.q, mode: 'insensitive' } }, { displayValue: { contains: q.q, mode: 'insensitive' } }, { subject: { canonicalName: { contains: q.q, mode: 'insensitive' } } }] }] } : {}),
      },
      include: { subject: { select: { id: true, canonicalName: true, type: true } } },
      orderBy: { key: 'asc' },
      take: 200,
    });
    const counts = await db.factMention.groupBy({ by: ['factId', 'state'], where: { tenantId, factId: { in: rows.map((r) => r.id) } }, _count: true });
    return rows.map((f) => ({ ...presentFact(f), mentions: tally(counts.filter((c) => c.factId === f.id)) }));
  }

  async get(tenantId: string, id: string) {
    const f = await this.prisma.forTenant({ tenantId }).fact.findFirst({ where: { id, tenantId, deletedAt: null }, include: { subject: { select: { id: true, canonicalName: true, type: true, aliases: true } }, source: { select: { id: true, name: true, uri: true, kind: true } } } });
    if (!f) throw notFound('Fact');
    return f;
  }

  async detail(tenantId: string, id: string) {
    const f = await this.get(tenantId, id);
    const counts = await this.prisma.forTenant({ tenantId }).factMention.groupBy({ by: ['factId', 'state'], where: { tenantId, factId: id }, _count: true });
    return { ...presentFact(f), aliases: f.subject.aliases, source: f.source, mentions: tally(counts) };
  }

  async create(actor: TenantPrincipal, body: CreateFactBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    if (await db.fact.findFirst({ where: { tenantId: actor.tenantId, key: body.key } })) throw conflict(`Fact "${body.key}" already exists`);
    const displayValue = body.displayValue ?? formatFactValue(body.valueType, body.value, body.unit);
    if (!displayValue) throw badRequest('INVALID_VALUE', `The value does not fit type ${body.valueType}`);
    const fact = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      const subjectId = 'id' in body.subject ? (await tx.kgEntity.findFirstOrThrow({ where: { id: body.subject.id, tenantId: actor.tenantId } })).id : (await this.upsertEntity(tx, actor.tenantId, body.siteId ?? null, body.subject.type, body.subject.name)).id;
      const f = await tx.fact.create({
        data: { tenantId: actor.tenantId, siteId: body.siteId ?? null, key: body.key, subjectId, predicate: body.predicate, valueType: body.valueType, value: body.value as Prisma.InputJsonValue, displayValue, unit: body.unit ?? null, expiresAt: body.expiresAt ?? null },
      });
      await tx.factVersion.create({ data: { tenantId: actor.tenantId, factId: f.id, version: 1, value: f.value as Prisma.InputJsonValue, displayValue, origin: 'USER', reason: 'Created', changedById: actor.userId ?? null, validFrom: f.validFrom } });
      return f;
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'fact.created', entityType: 'Fact', entityId: fact.id, changes: { key: fact.key, value: fact.displayValue } }, actor);
    return this.detail(actor.tenantId, fact.id);
  }

  /**
   * A value change is a new version: history is append-only, DETECTED mentions that matched the
   * old value become STALE (they now need a rewrite), and every site whose pages BIND the fact is
   * re-rendered — BOUND mentions propagate for free, no model involved.
   */
  async update(actor: TenantPrincipal, id: string, body: UpdateFactBody) {
    const f = await this.get(actor.tenantId, id);
    const valueType = f.valueType as FactValueType;
    const value = body.value ?? (f.value as Record<string, unknown>);
    const unit = body.unit === undefined ? f.unit : body.unit;
    const displayValue = body.displayValue ?? (body.value || body.unit !== undefined ? formatFactValue(valueType, value, unit) : f.displayValue);
    if (!displayValue) throw badRequest('INVALID_VALUE', `The value does not fit type ${valueType}`);
    const changed = JSON.stringify(value) !== JSON.stringify(f.value) || displayValue !== f.displayValue;

    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      const version = changed ? f.version + 1 : f.version;
      await tx.fact.update({
        where: { id },
        data: {
          value: value as Prisma.InputJsonValue,
          displayValue,
          unit,
          version,
          ...(body.status ? { status: body.status } : {}),
          ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
          ...(changed ? { validFrom: body.validFrom ?? new Date() } : {}),
        },
      });
      if (!changed) return;
      await tx.factVersion.create({ data: { tenantId: actor.tenantId, factId: id, version, value: value as Prisma.InputJsonValue, displayValue, origin: actor.actorType === 'user' ? 'USER' : 'AGENT', reason: body.reason ?? null, changedById: actor.userId ?? null, validFrom: body.validFrom ?? new Date() } });
      await tx.factMention.updateMany({ where: { tenantId: actor.tenantId, factId: id, kind: 'DETECTED', state: 'IN_SYNC' }, data: { state: 'STALE' } });
      await tx.factMention.updateMany({ where: { tenantId: actor.tenantId, factId: id, kind: 'BOUND' }, data: { factVersionSeen: version, observedValue: value as Prisma.InputJsonValue } });
      const bound = await tx.factMention.findMany({ where: { tenantId: actor.tenantId, factId: id, kind: 'BOUND' }, select: { entityType: true, entityId: true }, distinct: ['entityType', 'entityId'] });
      for (const [siteId, entities] of await this.bySite(actor.tenantId, bound.map((b) => ({ type: b.entityType as TargetType, id: b.entityId })))) {
        await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Fact', aggregateId: id, type: 'FactChanged', payload: { siteId, factId: id, key: f.key, version, entities } as unknown as Prisma.InputJsonObject });
      }
    });
    await this.audit.record({ tenantId: actor.tenantId, action: changed ? 'fact.value_changed' : 'fact.updated', entityType: 'Fact', entityId: id, changes: { from: f.displayValue, to: displayValue, reason: body.reason ?? null } }, actor);
    return { fact: await this.detail(actor.tenantId, id), changed, impact: await this.impact(actor.tenantId, id) };
  }

  async remove(actor: TenantPrincipal, id: string): Promise<void> {
    const f = await this.get(actor.tenantId, id);
    const bound = await this.prisma.forTenant({ tenantId: actor.tenantId }).factMention.count({ where: { factId: id, kind: 'BOUND' } });
    if (bound > 0) throw new ApiError('FACT_IN_USE', `${bound} content field(s) render this fact — unbind them or deprecate the fact instead`, 409, { bound });
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) => tx.fact.update({ where: { id }, data: { deletedAt: new Date(), key: `${f.key}.deleted_${Date.now()}` } }));
    await this.audit.record({ tenantId: actor.tenantId, action: 'fact.deleted', entityType: 'Fact', entityId: id, changes: { key: f.key } }, actor);
  }

  async versions(tenantId: string, id: string) {
    await this.get(tenantId, id);
    return this.prisma.forTenant({ tenantId }).factVersion.findMany({ where: { factId: id }, orderBy: { version: 'desc' }, select: { version: true, displayValue: true, value: true, origin: true, reason: true, validFrom: true, createdAt: true, branchId: true, changedBy: { select: { name: true } } } });
  }

  /** Impact analysis: every place the fact appears, grouped by page/entry, before anyone changes it. */
  async impact(tenantId: string, id: string, siteId?: string) {
    const rows = await this.prisma.forTenant({ tenantId }).factMention.findMany({ where: { tenantId, factId: id }, orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }] });
    const described = await this.describe(tenantId, rows.map((r) => ({ type: r.entityType as TargetType, id: r.entityId })));
    const groups = new Map<string, { entity: NonNullable<ReturnType<typeof described.get>>; mentions: unknown[] }>();
    for (const m of rows) {
      const entity = described.get(`${m.entityType}:${m.entityId}`);
      if (!entity || (siteId && entity.siteId !== siteId)) continue;
      const k = `${m.entityType}:${m.entityId}`;
      if (!groups.has(k)) groups.set(k, { entity, mentions: [] });
      const { blockId, fieldPath } = parseStoredPath(m.fieldPath);
      groups.get(k)!.mentions.push({ id: m.id, kind: m.kind, state: m.state, surfaceText: m.surfaceText, blockId, fieldPath, locale: m.locale, confidence: m.confidence, factVersionSeen: m.factVersionSeen, observedValue: m.observedValue });
    }
    const all = rows.filter((r) => groups.has(`${r.entityType}:${r.entityId}`));
    return {
      totals: {
        mentions: all.length,
        entities: groups.size,
        bound: all.filter((r) => r.kind === 'BOUND').length,
        detected: all.filter((r) => r.kind === 'DETECTED').length,
        stale: all.filter((r) => r.state === 'STALE').length,
        conflicts: all.filter((r) => r.state === 'CONFLICT').length,
        locales: [...new Set(all.map((r) => r.locale))],
      },
      entities: [...groups.values()],
    };
  }

  /** The Canon inbox: content that contradicts a fact (CONFLICT) or predates its last change (STALE). */
  async conflicts(tenantId: string, siteId?: string) {
    const rows = await this.prisma.forTenant({ tenantId }).factMention.findMany({
      where: { tenantId, state: { in: ['CONFLICT', 'STALE'] } },
      include: { fact: { select: { id: true, key: true, displayValue: true, version: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    });
    const described = await this.describe(tenantId, rows.map((r) => ({ type: r.entityType as TargetType, id: r.entityId })));
    return rows.flatMap((m) => {
      const entity = described.get(`${m.entityType}:${m.entityId}`);
      if (!entity || (siteId && entity.siteId !== siteId)) return [];
      return [{ id: m.id, state: m.state, surfaceText: m.surfaceText, observedValue: m.observedValue, confidence: m.confidence, locale: m.locale, ...parseStoredPath(m.fieldPath), fact: m.fact, entity }];
    });
  }

  async dismiss(actor: TenantPrincipal, mentionId: string, dismissed: boolean) {
    const m = await this.prisma.forTenant({ tenantId: actor.tenantId }).factMention.findFirst({ where: { id: mentionId, tenantId: actor.tenantId } });
    if (!m) throw notFound('Mention');
    await this.prisma.rawForTenant({ tenantId: actor.tenantId }, (tx) => tx.factMention.update({ where: { id: mentionId }, data: { state: dismissed ? 'DISMISSED' : 'CONFLICT' } }));
    if (!dismissed) await this.mentions.index(actor.tenantId, m.entityType as TargetType, m.entityId, { llm: false });
    return { ok: true };
  }

  /**
   * "Bind to fact": the detected span becomes a {{fact:key}} token in the draft, so it renders
   * the canonical value from now on and can never drift again. Only rich-text fields can hold
   * tokens; plain fields are rejected with a clear reason.
   */
  async bind(actor: TenantPrincipal, ability: AppAbility, mentionId: string) {
    const m = await this.prisma.forTenant({ tenantId: actor.tenantId }).factMention.findFirst({ where: { id: mentionId, tenantId: actor.tenantId }, include: { fact: { select: { key: true } } } });
    if (!m) throw notFound('Mention');
    if (m.kind === 'BOUND') return { ok: true, alreadyBound: true };
    const t = await this.targets.load(actor.tenantId, m.entityType as TargetType, m.entityId);
    if (!t) throw notFound('Content');
    const { blockId, fieldPath } = parseStoredPath(m.fieldPath);
    const field = t.fields.find((f) => f.blockId === blockId && f.fieldPath === fieldPath);
    if (!field) throw conflict('The text changed since it was scanned — re-scan and try again');
    if (field.kind !== 'rich') throw badRequest('NOT_BINDABLE', 'Only rich-text fields can hold fact tokens; edit this text or let propagation rewrite it');
    const token: InlineNode = { type: 'factRef', attrs: { factKey: m.fact.key } };
    const next = replaceSpan(field, m.surfaceText, token);
    if (!next) throw conflict('The span spans several formats or moved — bind it from the editor instead');
    await this.writeDraft(actor, ability, t.type, t.id, t.siteId, t.collectionId, t.version, withField(t, blockId, fieldPath, next));
    await this.mentions.index(actor.tenantId, t.type, t.id, { llm: false });
    return { ok: true };
  }

  async writeDraft(actor: TenantPrincipal, ability: AppAbility | null, type: TargetType, id: string, siteId: string, collectionId: string | null, expectedVersion: number, draft: unknown) {
    if (type === 'PAGE') {
      if (!ability) throw new Error('Page writes need an ability');
      return this.pages.update(actor, ability, siteId, id, { expectedVersion, content: draft });
    }
    return this.entries.update(actor, ability, siteId, collectionId!, id, { expectedVersion, data: draft as Record<string, unknown> });
  }

  async describe(tenantId: string, refs: EntityRef[]) {
    const db = this.prisma.forTenant({ tenantId });
    const pageIds = [...new Set(refs.filter((r) => r.type === 'PAGE').map((r) => r.id))];
    const entryIds = [...new Set(refs.filter((r) => r.type === 'ENTRY').map((r) => r.id))];
    const [pages, entries] = await Promise.all([
      pageIds.length ? db.page.findMany({ where: { id: { in: pageIds }, deletedAt: null }, select: { id: true, title: true, fullPath: true, siteId: true, locale: true, status: true } }) : [],
      entryIds.length ? db.entry.findMany({ where: { id: { in: entryIds }, deletedAt: null }, select: { id: true, title: true, slug: true, locale: true, status: true, collectionId: true, collection: { select: { siteId: true, name: true, slug: true } } } }) : [],
    ]);
    const map = new Map<string, { type: TargetType; id: string; title: string; path: string; siteId: string; locale: string; status: string; collectionId: string | null; collectionName: string | null }>();
    for (const p of pages) map.set(`PAGE:${p.id}`, { type: 'PAGE', id: p.id, title: p.title, path: p.fullPath, siteId: p.siteId, locale: p.locale, status: p.status, collectionId: null, collectionName: null });
    for (const e of entries) map.set(`ENTRY:${e.id}`, { type: 'ENTRY', id: e.id, title: e.title || e.slug, path: `/${e.collection.slug}/${e.slug}`, siteId: e.collection.siteId, locale: e.locale, status: e.status, collectionId: e.collectionId, collectionName: e.collection.name });
    return map;
  }

  private async bySite(tenantId: string, refs: EntityRef[]): Promise<Map<string, EntityRef[]>> {
    const described = await this.describe(tenantId, refs);
    const out = new Map<string, EntityRef[]>();
    for (const r of refs) {
      const d = described.get(`${r.type}:${r.id}`);
      if (d) out.set(d.siteId, [...(out.get(d.siteId) ?? []), r]);
    }
    return out;
  }

  private async upsertEntity(tx: Prisma.TransactionClient, tenantId: string, siteId: string | null, type: string, name: string) {
    // Case-insensitive match on the canonical name or an alias, so "Pro" and "pro" are one entity.
    const existing = await tx.kgEntity.findFirst({ where: { tenantId, deletedAt: null, type, OR: [{ canonicalName: { equals: name, mode: 'insensitive' } }, { aliases: { has: name } }] } });
    return existing ?? tx.kgEntity.create({ data: { tenantId, siteId, type, canonicalName: name } });
  }
}

function tally(counts: { state: string; _count: number }[]) {
  const by = (s: string) => counts.filter((c) => c.state === s).reduce((n, c) => n + c._count, 0);
  return { total: counts.reduce((n, c) => n + c._count, 0), inSync: by('IN_SYNC'), stale: by('STALE'), conflict: by('CONFLICT'), dismissed: by('DISMISSED') };
}

export function presentFact(f: Fact & { subject: { id: string; canonicalName: string; type: string } }) {
  return {
    id: f.id,
    key: f.key,
    siteId: f.siteId,
    subject: { id: f.subject.id, name: f.subject.canonicalName, type: f.subject.type },
    predicate: f.predicate,
    valueType: f.valueType,
    value: f.value,
    displayValue: f.displayValue,
    unit: f.unit,
    status: f.status,
    version: f.version,
    validFrom: f.validFrom,
    expiresAt: f.expiresAt,
    updatedAt: f.updatedAt,
  };
}
