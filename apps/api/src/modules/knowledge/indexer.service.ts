import { createHash } from 'node:crypto';
import { AiGateway } from '@canon/ai-gateway';
import type { PageContent } from '@canon/blocks';
import { toPgVector } from '@canon/db';
import { collectionFieldsSchema, type EntryData } from '@canon/fields';
import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { chunkSections, embeddingInput, type Chunk } from './chunker';
import { entrySections, pageSections } from './documents';

export const INDEX_QUEUE = 'ai-index';
const VECTOR_DIMS = 1536;
const EMBED_BATCH = 64;
/** Recorded instead of a model key when no embedding provider is available: lexical-only rows. */
export const NO_EMBEDDING = 'none';

export type IndexedType = 'PAGE' | 'ENTRY';

export interface IndexJob {
  tenantId: string;
  type: IndexedType;
  id: string;
}

interface Doc {
  tenantId: string;
  siteId: string;
  locale: string;
  title: string;
  path: string;
  collection?: string;
  chunks: Chunk[];
}

/**
 * Keeps the retrieval index in step with *published* content (drafts are never searchable or
 * citable). Triggered by the same outbox events that purge the delivery cache, then queued, so
 * a slow embedding provider never holds the relay's transaction open.
 */
@Injectable()
export class KnowledgeIndexer implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly gateway: AiGateway,
    private readonly queues: Queues,
    private readonly bus: EventBus,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(KnowledgeIndexer.name);
  }

  onModuleInit(): void {
    const page = (e: StoredEvent) => this.schedule({ tenantId: e.tenantId, type: 'PAGE', id: (e.payload as { pageId: string }).pageId });
    const entry = (e: StoredEvent) => this.schedule({ tenantId: e.tenantId, type: 'ENTRY', id: (e.payload as { entryId: string }).entryId });
    for (const t of ['PagePublished', 'PageUnpublished', 'PageMoved']) this.bus.on(t, page);
    for (const t of ['EntryPublished', 'EntryUnpublished']) this.bus.on(t, entry);
    // A changed fact changes the text of every page that binds it.
    this.bus.on('FactChanged', async (e) => {
      const p = e.payload as { entities?: { type: IndexedType; id: string }[] };
      for (const x of p.entities ?? []) await this.schedule({ tenantId: e.tenantId, type: x.type, id: x.id });
    });
  }

  onApplicationBootstrap(): void {
    if (process.env.KNOWLEDGE === 'off') return;
    this.queues.worker<IndexJob>(INDEX_QUEUE, (job) => this.index(job.data).then(() => undefined), 2);
  }

  async schedule(job: IndexJob): Promise<void> {
    const q = this.queues.queue(INDEX_QUEUE);
    // BullMQ rejects ":" in custom job ids.
    const jobId = `${job.type}-${job.id}`;
    const existing = await q.getJob(jobId);
    if (existing && ['waiting', 'delayed'].includes(await existing.getState())) return;
    if (existing) await existing.remove().catch(() => undefined);
    await q.add('index', job, { jobId, removeOnComplete: true, removeOnFail: true, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } });
  }

  /** Public for tests and backfills: indexes one entity now. */
  async index(job: IndexJob): Promise<{ chunks: number; embedded: boolean; skipped?: boolean; removed?: boolean }> {
    const doc = job.type === 'PAGE' ? await this.pageDoc(job.tenantId, job.id) : await this.entryDoc(job.tenantId, job.id);
    if (!doc) {
      await this.remove(job.tenantId, job.type, job.id);
      return { chunks: 0, embedded: false, removed: true };
    }
    const docHash = createHash('sha256').update(JSON.stringify([doc.title, doc.path, doc.chunks.map((c) => [c.heading, c.text])])).digest('hex');
    const prev = await this.system.$queryRaw<{ hash: string | null; model: string }[]>`
      SELECT metadata->>'docHash' AS hash, "embeddingModel" AS model FROM ai_vector_documents
      WHERE "tenantId" = ${job.tenantId} AND "entityType" = ${job.type}::"ContentEntityType" AND "entityId" = ${job.id} AND "chunkIndex" = 0 LIMIT 1`;
    // Unchanged text keeps its vectors; a lexical-only row is retried in case a model appeared since.
    if (prev[0]?.hash === docHash && prev[0].model !== NO_EMBEDDING) return { chunks: doc.chunks.length, embedded: true, skipped: true };

    const vectors = await this.embed(job.tenantId, doc);
    const model = vectors?.model ?? NO_EMBEDDING;
    await this.system.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM ai_vector_documents WHERE "tenantId" = ${job.tenantId} AND "entityType" = ${job.type}::"ContentEntityType" AND "entityId" = ${job.id}`;
      for (const c of doc.chunks) {
        const meta = JSON.stringify({ title: doc.title, path: doc.path, heading: c.heading ?? null, anchor: c.anchor ?? null, collection: doc.collection ?? null, ...(c.index === 0 ? { docHash } : {}) });
        const hash = createHash('sha256').update(`${model}\n${c.text}`).digest('hex');
        const v = vectors?.list[c.index];
        if (v) {
          await tx.$executeRaw`
            INSERT INTO ai_vector_documents (id, "tenantId", "siteId", "entityType", "entityId", locale, "chunkIndex", "chunkText", "contentHash", embedding, metadata, "embeddingModel", "updatedAt")
            VALUES (gen_random_uuid()::text, ${doc.tenantId}, ${doc.siteId}, ${job.type}::"ContentEntityType", ${job.id}, ${doc.locale}, ${c.index}, ${c.text}, ${hash}, ${toPgVector(v)}::vector, ${meta}::jsonb, ${model}, now())`;
        } else {
          await tx.$executeRaw`
            INSERT INTO ai_vector_documents (id, "tenantId", "siteId", "entityType", "entityId", locale, "chunkIndex", "chunkText", "contentHash", metadata, "embeddingModel", "updatedAt")
            VALUES (gen_random_uuid()::text, ${doc.tenantId}, ${doc.siteId}, ${job.type}::"ContentEntityType", ${job.id}, ${doc.locale}, ${c.index}, ${c.text}, ${hash}, ${meta}::jsonb, ${model}, now())`;
        }
      }
    });
    return { chunks: doc.chunks.length, embedded: Boolean(vectors) };
  }

  async remove(tenantId: string, type: IndexedType, id: string): Promise<void> {
    await this.system.$executeRaw`DELETE FROM ai_vector_documents WHERE "tenantId" = ${tenantId} AND "entityType" = ${type}::"ContentEntityType" AND "entityId" = ${id}`;
  }

  /** Backfill: every published page and entry of a site (admin "Rebuild index"). */
  async reindexSite(tenantId: string, siteId: string): Promise<{ pages: number; entries: number }> {
    const [pages, entries] = await Promise.all([
      this.system.page.findMany({ where: { tenantId, siteId, deletedAt: null, publishedVersion: { not: null } }, select: { id: true } }),
      this.system.entry.findMany({ where: { tenantId, deletedAt: null, publishedVersion: { not: null }, collection: { siteId, deletedAt: null } }, select: { id: true } }),
    ]);
    for (const p of pages) await this.schedule({ tenantId, type: 'PAGE', id: p.id });
    for (const e of entries) await this.schedule({ tenantId, type: 'ENTRY', id: e.id });
    return { pages: pages.length, entries: entries.length };
  }

  private async facts(tenantId: string): Promise<Record<string, string>> {
    const rows = await this.system.fact.findMany({ where: { tenantId, deletedAt: null }, select: { key: true, displayValue: true } });
    return Object.fromEntries(rows.map((f) => [f.key, f.displayValue]));
  }

  private async pageDoc(tenantId: string, pageId: string): Promise<Doc | null> {
    const page = await this.system.page.findFirst({ where: { id: pageId, tenantId, deletedAt: null, publishedVersion: { not: null } }, select: { siteId: true, locale: true, fullPath: true, title: true, publishedVersion: true } });
    if (!page) return null;
    const v = await this.system.pageVersion.findUnique({ where: { pageId_version: { pageId, version: page.publishedVersion! } }, select: { content: true } });
    if (!v) return null;
    const sections = pageSections(page.title, v.content as unknown as PageContent, await this.facts(tenantId));
    return { tenantId, siteId: page.siteId, locale: page.locale, title: page.title, path: page.fullPath, chunks: chunkSections(sections) };
  }

  private async entryDoc(tenantId: string, entryId: string): Promise<Doc | null> {
    const e = await this.system.entry.findFirst({
      where: { id: entryId, tenantId, deletedAt: null, publishedVersion: { not: null } },
      select: { locale: true, publishedVersion: true, collection: { select: { siteId: true, slug: true, schema: true, deletedAt: true } } },
    });
    if (!e || e.collection.deletedAt) return null;
    const v = await this.system.entryVersion.findUnique({ where: { entryId_version: { entryId, version: e.publishedVersion! } }, select: { data: true, title: true, slug: true, summary: true } });
    if (!v) return null;
    const fields = collectionFieldsSchema.safeParse(e.collection.schema);
    const sections = entrySections(v.title || v.slug, fields.success ? fields.data : [], v.data as EntryData, await this.facts(tenantId));
    if (v.summary) sections.unshift({ heading: v.title, text: v.summary, anchor: 'summary' });
    return { tenantId, siteId: e.collection.siteId, locale: e.locale, title: v.title || v.slug, path: `/${e.collection.slug}/${v.slug}`, collection: e.collection.slug, chunks: chunkSections(sections) };
  }

  private async embed(tenantId: string, doc: Doc): Promise<{ model: string; list: number[][] } | null> {
    if (!doc.chunks.length) return null;
    try {
      const list: number[][] = [];
      let model = '';
      for (let i = 0; i < doc.chunks.length; i += EMBED_BATCH) {
        const batch = doc.chunks.slice(i, i + EMBED_BATCH);
        const res = await this.gateway.embed({ input: batch.map((c) => embeddingInput(c, doc.title)) }, { tenantId, feature: 'EMBEDDING', tags: { actor: 'system', pipeline: 'knowledge' } });
        if (res.vectors.some((v) => v.length !== VECTOR_DIMS)) return null;
        list.push(...res.vectors);
        model = res.model;
      }
      return { model, list };
    } catch (err) {
      this.logger.debug({ err, tenantId }, 'knowledge.embedding_unavailable');
      return null;
    }
  }
}
