import { createHash } from 'node:crypto';
import { AiGateway, type CompletionResult } from '@canon/ai-gateway';
import { toPgVector, type Entry, type Prisma } from '@canon/db';
import { collectionFieldsSchema, completeness, entryAiText, entryTitle, keywords, normalizeTag, textSimilarity, type EntryData, type FieldDef } from '@canon/fields';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { ctx, meta, parseJson, withForbidden, AiContentService } from '../content-ai/ai-content.service';
import { CollectionsService, type CollectionModel } from './collections.service';
import type { EnrichBody } from './collections.dto';
import { ENRICH_QUEUE, type EnrichJob } from './enrichment.queue';

const VECTOR_DIMS = 1536;
/** Reported as a possible duplicate from this score up (0..1). */
const DUPLICATE_THRESHOLD = 0.55;
const CANDIDATES = 20;

export type EnrichTask = 'tags' | 'summary' | 'quality' | 'embedding';

export interface DuplicateHit {
  id: string;
  title: string;
  slug: string;
  score: number;
  method: 'content' | 'title' | 'semantic';
}

interface EnrichOutput {
  summary?: unknown;
  tags?: unknown;
  quality?: { score?: unknown; issues?: unknown };
}

/**
 * AI enrichment of entries: tags, summary and a quality score in ONE model call (cheaper than
 * three), plus an embedding for semantic duplicate search. The deterministic parts — completeness
 * and shingle/trigram duplicate detection — work with no AI provider at all, so a tenant without
 * keys still gets quality hints and duplicate warnings.
 *
 * Enrichment never bumps the entry's version: it must not trigger VERSION_CONFLICT in an editor
 * that is open on the same entry.
 */
@Injectable()
export class EnrichmentService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly content: AiContentService,
    private readonly collections: CollectionsService,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EnrichmentService.name);
  }

  onApplicationBootstrap(): void {
    if (process.env.ENRICHMENT === 'off') return;
    this.queues.worker<EnrichJob>(ENRICH_QUEUE, (job) => this.runAutomatic(job.data), 2);
  }

  /** Worker path: runs the tasks the collection opted into, skipping unchanged content. */
  async runAutomatic(job: EnrichJob): Promise<void> {
    const entry = await this.prisma.forTenant({ tenantId: job.tenantId }).entry.findFirst({ where: { id: job.entryId, deletedAt: null } });
    if (!entry) return;
    const c = await this.collections.getById(job.tenantId, entry.collectionId);
    const tasks: EnrichTask[] = [];
    if (c.ai.autoTag) tasks.push('tags');
    if (c.ai.autoSummary) tasks.push('summary');
    if (c.ai.qualityScore) tasks.push('quality');
    if (c.ai.duplicateCheck) tasks.push('embedding');
    const actor: TenantPrincipal = { actorType: 'system', tenantId: job.tenantId };
    await this.enrich(actor, c, entry, { tasks, applyTags: true }, false);
  }

  /**
   * @param force re-run even if the text hasn't changed since the last enrichment (manual button).
   */
  async enrich(actor: TenantPrincipal, c: CollectionModel, entry: Entry, body: EnrichBody, force = true) {
    const tasks = new Set<EnrichTask>(body.tasks ?? ['tags', 'summary', 'quality', 'embedding']);
    const data = entry.data as EntryData;
    const text = entryAiText(c.fields, data);
    const prev = (entry.aiMeta ?? {}) as Record<string, unknown>;
    const hash = createHash('sha256').update(`${[...tasks].sort().join(',')}\n${text}`).digest('hex');
    if (!force && prev.enrichedHash === hash) return { skipped: true as const };

    const aiMeta: Record<string, unknown> = { ...prev, enrichedHash: hash, enrichedAt: new Date().toISOString() };
    const update: Prisma.EntryUncheckedUpdateManyInput = {};
    const done: string[] = [];
    let call: CompletionResult | null = null;

    const comp = completeness(c.fields, data);
    if (tasks.has('quality')) aiMeta.quality = { ...(prev.quality as object), completeness: round(comp.score), missing: comp.missing };

    const llmTasks = (['tags', 'summary', 'quality'] as const).filter((t) => tasks.has(t));
    if (llmTasks.length && text.trim()) {
      try {
        call = await this.llm(actor, c, entry, text, llmTasks);
        const out = parseJson<EnrichOutput>(call.text) ?? {};
        if (tasks.has('summary') && typeof out.summary === 'string' && out.summary.trim()) {
          update.summary = out.summary.trim().slice(0, 400);
          done.push('summary');
        }
        if (tasks.has('tags') && Array.isArray(out.tags)) {
          const suggested = this.cleanTags(out.tags, c);
          aiMeta.tags = { ai: suggested, model: call.model };
          if (body.applyTags) update.tags = [...new Set([...entry.tags, ...suggested])].slice(0, 30);
          done.push('tags');
        }
        if (tasks.has('quality') && out.quality) {
          const aiScore = clamp(Number(out.quality.score), 0, 100);
          const issues = Array.isArray(out.quality.issues) ? out.quality.issues.filter((i): i is string => typeof i === 'string').map((i) => i.slice(0, 200)).slice(0, 6) : [];
          // Completeness is measured, not judged: it anchors the score so the model can't call an empty entry great.
          const score = Number.isFinite(aiScore) ? Math.round(0.4 * comp.score * 100 + 0.6 * aiScore) : Math.round(comp.score * 100);
          aiMeta.quality = { score, ai: Number.isFinite(aiScore) ? aiScore : null, completeness: round(comp.score), missing: comp.missing, issues, model: call.model };
          update.qualityScore = score;
          done.push('quality');
        }
      } catch (err) {
        // Provider outages degrade to the deterministic parts instead of failing the whole enrichment.
        this.logger.warn({ err, entryId: entry.id }, 'enrichment.llm_failed');
        aiMeta.lastError = err instanceof Error ? err.message.slice(0, 200) : 'AI unavailable';
        // A previous AI score describes older content; the measured score is the honest fallback.
        if (tasks.has('quality')) {
          update.qualityScore = Math.round(comp.score * 100);
          aiMeta.quality = { score: update.qualityScore, ai: null, completeness: round(comp.score), missing: comp.missing, issues: [] };
        }
      }
    } else if (tasks.has('quality')) {
      update.qualityScore = Math.round(comp.score * 100);
    }

    let semantic = false;
    if (tasks.has('embedding') && text.trim()) {
      semantic = await this.storeEmbedding(actor, c, entry, text);
      const dups = await this.findDuplicates(actor.tenantId, c, { id: entry.id, title: entry.title, locale: entry.locale, text }, semantic);
      aiMeta.duplicates = dups.slice(0, 5);
      aiMeta.semanticIndex = semantic;
      done.push('duplicates');
    }

    update.aiMeta = aiMeta as Prisma.InputJsonValue;
    await this.prisma.rawForTenant({ tenantId: actor.tenantId }, (tx) => tx.entry.updateMany({ where: { id: entry.id, deletedAt: null }, data: update }));
    return { skipped: false as const, done, aiMeta, ...(call ? { ai: meta(call) } : {}) };
  }

  /**
   * Duplicate candidates come from Postgres (title trigram + keyword full-text, plus vector
   * nearest neighbours when the entry is embedded) and are then scored on content shingles in
   * process — so the final number means the same thing whichever index found the candidate.
   */
  async findDuplicates(tenantId: string, c: CollectionModel, probe: { id: string | null; title: string; locale: string; text: string }, semantic: boolean): Promise<DuplicateHit[]> {
    const self = probe.id ?? '';
    const words = keywords(probe.text);
    const tsq = words.join(' | ');
    const rows = await this.prisma.rawForTenant({ tenantId }, async (tx) => {
      const byTitle = probe.title
        ? await tx.$queryRaw<{ id: string; sim: number }[]>`
            SELECT id, similarity(title, ${probe.title})::float AS sim FROM entries
            WHERE "collectionId" = ${c.row.id} AND locale = ${probe.locale} AND "deletedAt" IS NULL AND id <> ${self} AND title % ${probe.title}
            ORDER BY sim DESC LIMIT ${CANDIDATES}`
        : [];
      const byText = tsq
        ? await tx.$queryRaw<{ id: string; sim: number }[]>`
            SELECT id, 0::float AS sim FROM entries
            WHERE "collectionId" = ${c.row.id} AND locale = ${probe.locale} AND "deletedAt" IS NULL AND id <> ${self}
              AND "searchVector" @@ to_tsquery('simple', ${tsq})
            ORDER BY ts_rank("searchVector", to_tsquery('simple', ${tsq})) DESC LIMIT ${CANDIDATES}`
        : [];
      const byVector =
        semantic && probe.id
          ? await tx.$queryRaw<{ id: string; sim: number }[]>`
              SELECT d."entityId" AS id, (1 - (d.embedding <=> src.embedding))::float AS sim
              FROM ai_vector_documents d, ai_vector_documents src
              WHERE src."entityType" = 'ENTRY' AND src."entityId" = ${probe.id} AND src."chunkIndex" = 0
                AND d."entityType" = 'ENTRY' AND d."entityId" <> ${probe.id} AND d."embeddingModel" = src."embeddingModel"
                AND d."tenantId" = ${tenantId} AND d.metadata->>'collectionId' = ${c.row.id}
              ORDER BY d.embedding <=> src.embedding LIMIT 10`
          : [];
      return { byTitle, byText, byVector };
    });
    const titleSim = new Map(rows.byTitle.map((r) => [r.id, r.sim]));
    const vecSim = new Map(rows.byVector.map((r) => [r.id, r.sim]));
    const ids = [...new Set([...titleSim.keys(), ...rows.byText.map((r) => r.id), ...vecSim.keys()])];
    if (!ids.length) return [];
    const candidates = await this.prisma.forTenant({ tenantId }).entry.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, title: true, slug: true, data: true } });
    const hits = candidates.map((e): DuplicateHit => {
      const content = textSimilarity(probe.text, entryAiText(c.fields, e.data as EntryData));
      const title = titleSim.get(e.id) ?? 0;
      const vector = vecSim.get(e.id) ?? 0;
      // A shared title alone is weak evidence ("Pricing" vs "Pricing"); it only tips a borderline content match.
      const scored: [number, DuplicateHit['method']][] = [
        [content, 'content'],
        [title >= 0.9 ? 0.5 * title + 0.5 * content : 0, 'title'],
        [vector >= 0.92 ? vector * 0.9 : 0, 'semantic'],
      ];
      const [score, method] = scored.reduce((a, b) => (b[0] > a[0] ? b : a));
      return { id: e.id, title: e.title, slug: e.slug, score: round(score), method };
    });
    return hits.filter((h) => h.score >= DUPLICATE_THRESHOLD).sort((a, b) => b.score - a.score);
  }

  /** Check before saving (the editor's "possible duplicate" banner on new entries). */
  async checkDraft(tenantId: string, c: CollectionModel, data: EntryData, locale: string, excludeId?: string): Promise<DuplicateHit[]> {
    const text = entryAiText(c.fields, data);
    if (!text.trim()) return [];
    return this.findDuplicates(tenantId, c, { id: excludeId ?? null, title: entryTitle(c.fields, c.settings, data, ''), locale, text }, false);
  }

  /** "Describe your content" → a validated field list. Invalid fields are dropped, never "fixed" silently. */
  async suggestSchema(actor: TenantPrincipal, siteId: string, description: string) {
    const voice = await this.content.voice(actor.tenantId, siteId);
    const prompt = await this.prompts.get(actor.tenantId, 'collections.suggest_schema');
    const { system, user } = this.prompts.render(prompt, { siteName: voice.siteName, description });
    const res = await this.gateway.complete({ system, messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 2_000 }, ctx(actor, 'LAYOUT', prompt.id));
    const out = parseJson<{ name?: unknown; slug?: unknown; fields?: unknown }>(res.text);
    const raw = Array.isArray(out?.fields) ? out.fields : [];
    const fields: FieldDef[] = [];
    const dropped: { name: string; issues: string[] }[] = [];
    for (const f of raw) {
      const one = collectionFieldsSchema.safeParse([...fields, f]);
      if (one.success) fields.push(one.data.at(-1)!);
      else dropped.push({ name: String((f as { name?: unknown })?.name ?? '?'), issues: one.error.issues.map((i) => i.message).slice(0, 3) });
    }
    if (!fields.length) throw new ApiError('AI_BAD_OUTPUT', 'The model did not return usable fields — describe the content in more detail', 502, { dropped });
    return { name: typeof out?.name === 'string' ? out.name.slice(0, 80) : '', slug: typeof out?.slug === 'string' ? out.slug.slice(0, 60) : '', fields, dropped, ai: meta(res) };
  }

  private async llm(actor: TenantPrincipal, c: CollectionModel, entry: Entry, text: string, tasks: readonly ('tags' | 'summary' | 'quality')[]) {
    const site = c.row.siteId;
    const voice = await this.content.voice(actor.tenantId, site);
    const prompt = await this.prompts.get(actor.tenantId, 'collections.enrich');
    const vocab = c.ai.tagVocabulary;
    const { system, user } = this.prompts.render(prompt, {
      collection: c.row.name,
      locale: entry.locale,
      tasks: tasks.join(', '),
      maxTags: c.ai.maxTags,
      vocabulary: vocab.length ? vocab.join(', ') : '(open — propose short, reusable tags)',
      entry: text,
    });
    return this.gateway.complete(
      { system: withForbidden(system, voice), messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 800, cache: 'exact' },
      ctx(actor, 'CLASSIFY', prompt.id, { type: 'ENTRY', id: entry.id }),
    );
  }

  private cleanTags(raw: unknown[], c: CollectionModel): string[] {
    const vocab = new Map(c.ai.tagVocabulary.map((t) => [normalizeTag(t), normalizeTag(t)]));
    const tags = raw.filter((t): t is string => typeof t === 'string').map(normalizeTag).filter((t) => t && t.length >= 2);
    const allowed = vocab.size ? tags.filter((t) => vocab.has(t)) : tags;
    return [...new Set(allowed)].slice(0, c.ai.maxTags);
  }

  /** Returns false when no 1536-dim embedding model is available — duplicates then run on text only. */
  private async storeEmbedding(actor: TenantPrincipal, c: CollectionModel, entry: Entry, text: string): Promise<boolean> {
    try {
      // No prompt behind embeddings: promptId is a FK in the ledger, so it stays unset.
      const res = await this.gateway.embed({ input: [text.slice(0, 8_000)] }, { tenantId: actor.tenantId, userId: actor.userId, feature: 'EMBEDDING', relatedEntity: { type: 'ENTRY', id: entry.id }, tags: { actor: actor.actorType } });
      const v = res.vectors[0];
      if (!v || v.length !== VECTOR_DIMS) return false;
      const hash = createHash('sha256').update(`${res.model}\n${text}`).digest('hex');
      const metadata = JSON.stringify({ collectionId: c.row.id, locale: entry.locale });
      await this.prisma.rawForTenant({ tenantId: actor.tenantId }, (tx) => tx.$executeRaw`
        INSERT INTO ai_vector_documents (id, "tenantId", "siteId", "entityType", "entityId", locale, "chunkIndex", "chunkText", "contentHash", embedding, metadata, "embeddingModel", "updatedAt")
        VALUES (gen_random_uuid()::text, ${actor.tenantId}, ${c.row.siteId}, 'ENTRY', ${entry.id}, ${entry.locale}, 0, ${text.slice(0, 2_000)}, ${hash}, ${toPgVector(v)}::vector, ${metadata}::jsonb, ${res.model}, now())
        ON CONFLICT ("entityType", "entityId", "chunkIndex", "embeddingModel")
        DO UPDATE SET embedding = EXCLUDED.embedding, "chunkText" = EXCLUDED."chunkText", "contentHash" = EXCLUDED."contentHash", metadata = EXCLUDED.metadata, "updatedAt" = now()`);
      return true;
    } catch (err) {
      this.logger.debug({ err, entryId: entry.id }, 'enrichment.embedding_unavailable');
      return false;
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : Number.NaN);
