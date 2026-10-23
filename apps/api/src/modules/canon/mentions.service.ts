import { AiGateway } from '@canon/ai-gateway';
import { Prisma, type FactMention } from '@canon/db';
import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { parseJson } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { detectSpans, sameValue, type FactLike, type FactValueType } from './fact-values';
import { boundKeys, ContentTargets, plainOf, type ContentTarget, type TargetField, type TargetType } from './targets';

export const EXTRACT_QUEUE = 'canon-extract';
/** Autosave fires every few seconds; extraction runs once the editor pauses. */
const DEBOUNCE_MS = 20_000;
const MAX_LLM_CHARS = 12_000;

export interface CanonFactRow extends FactLike {
  version: number;
  subjectId: string;
  subject: string;
}

interface Draft {
  factId: string;
  kind: 'BOUND' | 'DETECTED';
  state: 'IN_SYNC' | 'STALE' | 'CONFLICT' | 'DISMISSED';
  field: TargetField;
  surfaceText: string;
  observedValue: unknown;
  confidence: number;
  generationId?: string;
}

export interface Candidate {
  subject: string;
  predicate: string;
  valueType: string;
  value: unknown;
  surfaceText: string;
}

/** Mentions are unique per field *and* block; page props repeat across blocks ("title"). */
export const storedPath = (f: Pick<TargetField, 'blockId' | 'fieldPath'>) => (f.blockId ? `${f.blockId}:${f.fieldPath}` : f.fieldPath);
export function parseStoredPath(stored: string): { blockId: string | null; fieldPath: string } {
  const i = stored.indexOf(':');
  return i < 0 ? { blockId: null, fieldPath: stored } : { blockId: stored.slice(0, i), fieldPath: stored.slice(i + 1) };
}

/**
 * The Canon linter. Rebuilds an entity's fact mentions from its *draft*:
 *  - BOUND: `{{fact:key}}` tokens in rich text — always in sync, they render the live value;
 *  - DETECTED (deterministic): verbatim display values and subject-scoped money amounts;
 *  - DETECTED (model): canon.extract_facts claims matched to known facts, for paraphrases
 *    ("forty-nine dollars", "under fifty") the rules can't see.
 * The deterministic pass always runs; a provider outage only loses the model's extra recall.
 */
@Injectable()
export class MentionsService implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly targets: ContentTargets,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly queues: Queues,
    private readonly bus: EventBus,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MentionsService.name);
  }

  onModuleInit(): void {
    const on = (type: TargetType) => (e: StoredEvent) => this.schedule(e.tenantId, type, (e.payload as { pageId?: string; entryId?: string })[type === 'PAGE' ? 'pageId' : 'entryId']!);
    this.bus.on('PageChanged', on('PAGE'));
    this.bus.on('EntryChanged', on('ENTRY'));
  }

  onApplicationBootstrap(): void {
    if (process.env.CANON_EXTRACT === 'off') return;
    this.queues.worker<{ tenantId: string; type: TargetType; id: string }>(EXTRACT_QUEUE, (job) => this.index(job.data.tenantId, job.data.type, job.data.id).then(() => undefined), 2);
  }

  async schedule(tenantId: string, type: TargetType, id: string): Promise<void> {
    const q = this.queues.queue(EXTRACT_QUEUE);
    // BullMQ rejects ":" in custom job ids.
    const jobId = `${type}-${id}`;
    const existing = await q.getJob(jobId);
    if (existing && ['waiting', 'delayed'].includes(await existing.getState())) return;
    if (existing) await existing.remove().catch(() => undefined);
    await q.add('extract', { tenantId, type, id }, { jobId, delay: DEBOUNCE_MS, removeOnComplete: true, removeOnFail: true, attempts: 3 });
  }

  async factsFor(tenantId: string, siteId: string): Promise<CanonFactRow[]> {
    const rows = await this.system.fact.findMany({
      where: { tenantId, deletedAt: null, status: { not: 'DEPRECATED' }, OR: [{ siteId: null }, { siteId }] },
      include: { subject: { select: { canonicalName: true, aliases: true } } },
    });
    return rows.map((f) => ({
      id: f.id,
      key: f.key,
      valueType: f.valueType as FactValueType,
      value: f.value,
      displayValue: f.displayValue,
      unit: f.unit,
      version: f.version,
      subjectId: f.subjectId,
      subject: f.subject.canonicalName,
      subjectNames: [f.subject.canonicalName, ...f.subject.aliases],
    }));
  }

  /** Re-scans one entity. `llm: false` is the instant path used after merges and by the API linter. */
  async index(tenantId: string, type: TargetType, id: string, opts: { llm?: boolean } = {}) {
    const target = await this.targets.load(tenantId, type, id);
    if (!target) {
      await this.system.factMention.deleteMany({ where: { tenantId, entityType: type, entityId: id } });
      return { mentions: 0, conflicts: 0, candidates: [] as Candidate[] };
    }
    const facts = await this.factsFor(tenantId, target.siteId);
    const byKey = new Map(facts.map((f) => [f.key, f]));
    const byId = new Map(facts.map((f) => [f.id, f]));
    const drafts: Draft[] = [];

    for (const field of target.fields) {
      for (const key of boundKeys(field)) {
        const f = byKey.get(key);
        if (f) drafts.push({ factId: f.id, kind: 'BOUND', state: 'IN_SYNC', field, surfaceText: `{{fact:${key}}}`, observedValue: f.value, confidence: 1 });
      }
      for (const s of detectSpans(plainOf(field), facts)) {
        drafts.push({ factId: s.factId, kind: 'DETECTED', state: s.inSync ? 'IN_SYNC' : 'CONFLICT', field, surfaceText: s.surfaceText, observedValue: s.observedValue, confidence: s.confidence });
      }
    }

    let candidates: Candidate[] = [];
    if (opts.llm !== false && facts.length) {
      const extracted = await this.extract(target, facts).catch((err: unknown) => {
        this.logger.warn({ err, entityId: id }, 'canon.extract_failed');
        return null;
      });
      if (extracted) {
        candidates = extracted.candidates;
        for (const d of extracted.drafts) if (!drafts.some((x) => x.factId === d.factId && x.field === d.field && x.surfaceText === d.surfaceText)) drafts.push(d);
      }
    }

    const previous = await this.system.factMention.findMany({ where: { tenantId, entityType: type, entityId: id } });
    const rows = this.reconcile(target, drafts, previous, byId);
    await this.system.$transaction(async (tx) => {
      await tx.factMention.deleteMany({ where: { tenantId, entityType: type, entityId: id } });
      if (rows.length) await tx.factMention.createMany({ data: rows });
    });
    return { mentions: rows.length, conflicts: rows.filter((r) => r.state === 'CONFLICT' || r.state === 'STALE').length, candidates };
  }

  /** Deterministic findings for arbitrary text (editor squiggles before saving). */
  async lint(tenantId: string, siteId: string, text: string) {
    const facts = await this.factsFor(tenantId, siteId);
    return detectSpans(text, facts).map((s) => {
      const f = facts.find((x) => x.id === s.factId)!;
      return { factId: f.id, key: f.key, surfaceText: s.surfaceText, start: s.start, inSync: s.inSync, canonical: f.displayValue, confidence: s.confidence };
    });
  }

  /**
   * Keeps human decisions across re-scans: a dismissed span stays dismissed, and a span that was
   * in sync with an older fact version is STALE (not a fresh CONFLICT) until propagation lands.
   */
  private reconcile(t: ContentTarget, drafts: Draft[], previous: FactMention[], facts: Map<string, CanonFactRow>): Prisma.FactMentionCreateManyInput[] {
    const keyOf = (factId: string, path: string, surface: string) => `${factId}|${path}|${surface}`;
    const prev = new Map(previous.map((m) => [keyOf(m.factId, m.fieldPath, m.surfaceText), m]));
    const seen = new Set<string>();
    const out: Prisma.FactMentionCreateManyInput[] = [];
    for (const d of drafts) {
      const fact = facts.get(d.factId);
      if (!fact) continue;
      const path = storedPath(d.field);
      const key = keyOf(d.factId, path, d.surfaceText);
      if (seen.has(key)) continue; // same value twice in one field: one mention is enough to act on
      seen.add(key);
      const before = prev.get(key);
      let state = d.state;
      let versionSeen = fact.version;
      if (before?.state === 'DISMISSED') state = 'DISMISSED';
      else if (d.kind === 'DETECTED' && state === 'CONFLICT' && before && (before.state === 'STALE' || (before.state === 'IN_SYNC' && before.factVersionSeen < fact.version))) {
        state = 'STALE';
        versionSeen = before.factVersionSeen;
      }
      const plain = plainOf(d.field);
      const at = plain.indexOf(d.surfaceText);
      out.push({
        tenantId: t.tenantId,
        factId: d.factId,
        entityType: t.type,
        entityId: t.id,
        locale: t.locale,
        blockId: d.field.blockId,
        fieldPath: path,
        anchor: (d.kind === 'BOUND' ? { token: d.surfaceText.slice(7, -2) } : { quote: { prefix: at > 0 ? plain.slice(Math.max(0, at - 32), at) : '', exact: d.surfaceText, suffix: at >= 0 ? plain.slice(at + d.surfaceText.length, at + d.surfaceText.length + 32) : '' } }) as Prisma.InputJsonValue,
        surfaceText: d.surfaceText,
        observedValue: (d.observedValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        kind: d.kind,
        state,
        confidence: d.confidence,
        factVersionSeen: versionSeen,
        detectedByGenerationId: d.generationId ?? null,
      });
    }
    return out;
  }

  private async extract(t: ContentTarget, facts: CanonFactRow[]): Promise<{ drafts: Draft[]; candidates: Candidate[] } | null> {
    const lines = t.fields.map((f) => ({ f, text: plainOf(f).trim() })).filter((x) => x.text);
    if (!lines.length) return null;
    const content = lines.map((l) => l.text).join('\n\n').slice(0, MAX_LLM_CHARS);
    const prompt = await this.prompts.get(t.tenantId, 'canon.extract_facts');
    const entities = [...new Map(facts.map((f) => [f.subjectId, f.subject])).entries()];
    const { system, user } = this.prompts.render(prompt, {
      entities: entities.map(([id, name]) => `${id}: ${name}`).join('\n') || '(none)',
      facts: facts.map((f) => `${f.key} | ${f.subject} | ${f.valueType} | ${f.displayValue}`).join('\n'),
      locale: t.locale,
      content,
    });
    const res = await this.gateway.complete(
      { system, messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 2_000, cache: 'exact' },
      { tenantId: t.tenantId, feature: 'FACT_EXTRACT', promptId: prompt.id, relatedEntity: { type: t.type, id: t.id }, tags: { pipeline: 'canon' } },
    );
    const out = parseJson<{ claims?: unknown }>(res.text);
    const claims = Array.isArray(out?.claims) ? out.claims : [];
    const byKey = new Map(facts.map((f) => [f.key, f]));
    const drafts: Draft[] = [];
    const candidates: Candidate[] = [];
    for (const raw of claims.slice(0, 100)) {
      const c = raw as { matchesFactKey?: unknown; surfaceText?: unknown; value?: unknown; confidence?: unknown; predicate?: unknown; valueType?: unknown; subject?: { name?: unknown } };
      if (typeof c.surfaceText !== 'string' || !c.surfaceText.trim()) continue;
      // The model must quote verbatim; a span we can't find can't be propagated, so it's dropped.
      const line = lines.find((l) => l.text.includes(c.surfaceText as string));
      if (!line) continue;
      const fact = typeof c.matchesFactKey === 'string' ? byKey.get(c.matchesFactKey) : undefined;
      if (!fact) {
        candidates.push({ subject: String(c.subject?.name ?? ''), predicate: String(c.predicate ?? ''), valueType: String(c.valueType ?? 'TEXT'), value: c.value, surfaceText: c.surfaceText });
        continue;
      }
      const conf = typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : 0.8;
      drafts.push({ factId: fact.id, kind: 'DETECTED', state: sameValue(fact.valueType, fact.value, c.value) ? 'IN_SYNC' : 'CONFLICT', field: line.f, surfaceText: c.surfaceText, observedValue: c.value ?? null, confidence: conf, generationId: res.generationId });
    }
    return { drafts, candidates: candidates.slice(0, 20) };
  }
}
