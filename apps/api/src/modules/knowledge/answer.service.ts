import { AiGateway, type ChatMessage, type CompletionRequest, type StreamEvent } from '@canon/ai-gateway';
import { Inject, Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ctx, meta, withForbidden } from '../content-ai/ai-content.service';
import { AiContentService } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { SitesService, presentSite } from '../sites/sites.service';
import { KnowledgeSearch, type SearchHit } from './search.service';

const SOURCES = 6;
const MAX_FACTS = 8;
/** Below this the question doesn't really name the fact (pg_trgm word_similarity, 0..1). */
const FACT_SIMILARITY = 0.3;

export interface CanonFactRef {
  ref: string;
  id: string;
  key: string;
  subject: string;
  predicate: string;
  displayValue: string;
}

export interface Citation {
  n: number;
  title: string;
  heading: string | null;
  url: string;
  snippet: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
}

interface Prepared {
  request: CompletionRequest;
  citations: Citation[];
  facts: CanonFactRef[];
  promptId: string;
}

/**
 * Grounded answers: retrieved published content + the Canon facts relevant to the question.
 * Canonical facts outrank page text in the prompt, so a stale "$39" in an old post cannot beat
 * the fact graph's "$49". When every provider is down the gateway degrades to a template built
 * from the best-matching fact — a correct short answer beats an error page.
 */
@Injectable()
export class KnowledgeAnswers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly search: KnowledgeSearch,
    private readonly sites: SitesService,
    private readonly content: AiContentService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ask(p: TenantPrincipal, siteId: string, question: string, locale?: string) {
    const prep = await this.prepare(p, siteId, question, locale);
    const res = await this.gateway.complete(prep.request, ctx(p, 'CHAT', prep.promptId));
    const used = citedNumbers(res.text);
    return {
      answer: res.text.trim(),
      // Only sources the answer actually cites; a degraded answer cites none, so show the top ones.
      citations: used.size ? prep.citations.filter((c) => used.has(c.n)) : prep.citations.slice(0, 3),
      facts: prep.facts.filter((f) => res.text.includes(`[${f.ref}]`) || res.status === 'DEGRADED'),
      grounded: prep.citations.length > 0 || prep.facts.length > 0,
      ...meta(res),
    };
  }

  /** SSE flavour: sources first (the UI can render them while tokens stream), then deltas. */
  async *stream(p: TenantPrincipal, siteId: string, question: string, locale: string | undefined, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
    const prep = await this.prepare(p, siteId, question, locale);
    yield { event: 'sources', data: { citations: prep.citations, facts: prep.facts } };
    for await (const e of this.gateway.stream(prep.request, ctx(p, 'CHAT', prep.promptId), { signal }) as AsyncIterable<StreamEvent>) {
      if (e.type === 'delta') yield { event: 'delta', data: { text: e.text } };
      else if (e.type === 'done') yield { event: 'done', data: { ...meta(e.result), cited: [...citedNumbers(e.result.text)] } };
    }
  }

  private async prepare(p: TenantPrincipal, siteId: string, question: string, locale?: string): Promise<Prepared> {
    const site = await this.sites.get(p.tenantId, siteId);
    const base = presentSite(site, this.config).url;
    const { hits } = await this.search.search(p.tenantId, siteId, question, { locale, limit: SOURCES, perEntity: 2, userId: p.userId });
    const facts = await this.relevantFacts(p.tenantId, siteId, question, hits);
    const citations: Citation[] = hits.map((h, i) => ({
      n: i + 1,
      title: h.title,
      heading: h.heading,
      url: `${base}${h.path}`,
      snippet: h.snippet,
      entityType: h.entityType,
      entityId: h.entityId,
    }));

    const voice = await this.content.voice(p.tenantId, siteId);
    const prompt = await this.prompts.get(p.tenantId, 'knowledge.answer');
    const { system, user } = this.prompts.render(prompt, {
      siteName: site.name,
      facts: facts.length ? facts.map((f) => `[${f.ref}] ${f.subject} — ${f.predicate}: ${f.displayValue} (key ${f.key})`).join('\n') : '(none)',
      sources: hits.length ? hits.map((h, i) => `<source n="${i + 1}" title="${escapeAttr(h.title)}"${h.heading ? ` section="${escapeAttr(h.heading)}"` : ''}>\n${h.text}\n</source>`).join('\n') : '(no matching content)',
      question,
    });
    const messages: ChatMessage[] = [{ role: 'user', content: user }];
    const best = facts[0];
    return {
      promptId: prompt.id,
      citations,
      facts,
      request: {
        system: withForbidden(system, voice),
        messages,
        preferModel: prompt.modelKey,
        maxTokens: 700,
        // Exact, not semantic: the key includes the retrieved sources, so another site's answer can't be served.
        cache: 'exact',
        degradeWith: best ? `${best.subject} — ${best.predicate.replace(/_/g, ' ')}: ${best.displayValue} [${best.ref}]` : "I can't answer that right now. These pages may help:",
      },
    };
  }

  /**
   * Facts named by the question (trigram over key/predicate/subject) plus facts the retrieved
   * pages mention — the second set is how "is Pro cheaper than Business?" finds both prices.
   */
  private async relevantFacts(tenantId: string, siteId: string, question: string, hits: SearchHit[]): Promise<CanonFactRef[]> {
    const q = question.slice(0, 500);
    const entityIds = [...new Set(hits.map((h) => h.entityId))];
    const rows = await this.prisma.rawForTenant({ tenantId }, async (tx) => {
      const named = await tx.$queryRaw<{ id: string; sim: number }[]>`
        SELECT f.id, greatest(
          word_similarity(replace(replace(f.key, '_', ' '), '.', ' '), ${q}),
          word_similarity(replace(f.predicate, '_', ' ') || ' ' || e."canonicalName", ${q}),
          word_similarity(e."canonicalName", ${q})
        )::float AS sim
        FROM facts f JOIN kg_entities e ON e.id = f."subjectId"
        WHERE f."tenantId" = ${tenantId} AND f."deletedAt" IS NULL AND f.status = 'ACTIVE' AND (f."siteId" IS NULL OR f."siteId" = ${siteId})
        ORDER BY sim DESC LIMIT ${MAX_FACTS}`;
      const mentioned = entityIds.length
        ? await tx.$queryRaw<{ id: string }[]>`SELECT DISTINCT "factId" AS id FROM fact_mentions WHERE "tenantId" = ${tenantId} AND "entityId" = ANY(${entityIds}) AND state <> 'DISMISSED'`
        : [];
      return { named: named.filter((n) => n.sim >= FACT_SIMILARITY), mentioned };
    });
    const ids = [...new Set([...rows.named.map((r) => r.id), ...rows.mentioned.map((r) => r.id)])].slice(0, MAX_FACTS);
    if (!ids.length) return [];
    const facts = await this.prisma.forTenant({ tenantId }).fact.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, key: true, predicate: true, displayValue: true, subject: { select: { canonicalName: true } } } });
    const order = new Map(ids.map((id, i) => [id, i]));
    return facts
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .map((f, i) => ({ ref: `F${i + 1}`, id: f.id, key: f.key, subject: f.subject.canonicalName, predicate: f.predicate, displayValue: f.displayValue }));
  }
}

function citedNumbers(text: string): Set<number> {
  return new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
}

const escapeAttr = (s: string) => s.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c]!);
