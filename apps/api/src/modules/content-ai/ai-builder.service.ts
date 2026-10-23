import { AiGateway, type CompletionResult, type ChatMessage, type ContentPart } from '@canon/ai-gateway';
import { BLOCKS, blockCatalogForPrompt, mapBlockText, materializeBlocks, validatePageContent, type BlockNode, type MaterializeResult } from '@canon/blocks';
import { Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { MediaService } from '../media/media.service';
import { PagesService } from '../pages/pages.service';
import { SitesService } from '../sites/sites.service';
import { AiContentService, GOALS, ctx, meta, parseJson, withForbidden } from './ai-content.service';
import type { GenerateBlockBody, GeneratePageBody, ImproveBlockBody } from './content-ai.dto';

/** Facts the model may cite as tokens; more than this and the prompt gets noisy for little gain. */
const MAX_PROMPT_FACTS = 80;
/** Top-level blocks are layout, not content: the builder lists the rest (row children) in the catalog. */
const PAGE_TYPES = BLOCKS.map((b) => b.type).filter((t) => t !== 'column');

interface Draft {
  raw: unknown;
  title?: string;
  description?: string;
  result: MaterializeResult;
}

/**
 * AI page builder: "generate a page from a brief" and "generate one block". The model sees the
 * block catalog generated from the same Zod definitions the API validates against and the site's
 * Canon facts as citable tokens. Output is never trusted: it is materialised block by block
 * (fresh ids, coerced props, facts bound as factRefs), invalid blocks are dropped with reasons,
 * and one repair round-trip is attempted when anything was rejected. Results are drafts — the
 * editor applies them to its (undoable) store or a new draft page; nothing is published.
 */
@Injectable()
export class AiBuilderService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly prisma: PrismaService,
    private readonly content: AiContentService,
    private readonly sites: SitesService,
    private readonly pages: PagesService,
    private readonly media: MediaService,
  ) {}

  async generatePage(p: TenantPrincipal, siteId: string, body: GeneratePageBody) {
    const site = await this.sites.get(p.tenantId, siteId);
    const locale = body.locale ?? site.defaultLocale;
    if (!site.locales.includes(locale)) throw badRequest('INVALID_LOCALE', `Site does not have locale "${locale}"`);
    const [voice, facts, prompt] = await Promise.all([this.content.voice(p.tenantId, siteId), this.facts(p.tenantId, siteId), this.prompts.get(p.tenantId, 'builder.generate_page')]);

    const { system, user } = this.prompts.render(prompt, {
      siteName: voice.siteName,
      brandVoice: voice.brandVoice || 'clear, confident and helpful',
      locale,
      catalog: blockCatalogForPrompt(PAGE_TYPES.concat('column')),
      facts: formatFacts(facts),
      brief: body.brief,
    });
    const userContent: ChatMessage['content'] = body.screenshotMediaId
      ? [await this.screenshot(p.tenantId, siteId, body.screenshotMediaId), { type: 'text', text: `${user}\n\nThe attached image is a reference layout: mirror its structure and section order, not its text.` }]
      : user;

    const calls: CompletionResult[] = [];
    const call = async (messages: ChatMessage[]) => {
      const res = await this.gateway.complete(
        { system: withForbidden(system, voice), messages, preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 8_000, timeoutMs: 120_000 },
        ctx(p, 'LAYOUT', prompt.id, body.pageId ? { type: 'PAGE', id: body.pageId } : undefined),
      );
      calls.push(res);
      const parsed = parseJson<{ title?: unknown; description?: unknown; blocks?: unknown }>(res.text);
      return {
        text: res.text,
        draft: {
          raw: parsed?.blocks,
          title: typeof parsed?.title === 'string' ? parsed.title.slice(0, 200) : undefined,
          description: typeof parsed?.description === 'string' ? parsed.description.slice(0, 300) : undefined,
          result: materializeBlocks(parsed?.blocks, { facts: factMap(facts) }),
        } satisfies Draft,
      };
    };

    const first = await call([{ role: 'user', content: userContent }]);
    let best = first.draft;
    let repaired = false;
    if (needsRepair(best)) {
      const second = await call([
        { role: 'user', content: userContent },
        { role: 'assistant', content: first.text.slice(0, 30_000) },
        { role: 'user', content: repairRequest(best, 'blocks') },
      ]);
      repaired = true;
      if (score(second.draft) > score(best)) best = second.draft;
    }
    if (best.result.content.root.children.length === 0) {
      throw new ApiError('AI_BAD_OUTPUT', 'The model did not return a usable page — try rephrasing the brief', 502, { dropped: summarizeDropped(best) });
    }

    const out = {
      title: best.title ?? '',
      description: best.description ?? '',
      content: best.result.content,
      dropped: summarizeDropped(best),
      repaired,
      ai: summarize(calls),
    };
    if (!body.createPage) return out;

    const created = await this.pages.create(p, siteId, {
      title: body.createPage.title ?? (out.title || 'Untitled'),
      slug: body.createPage.slug,
      parentId: body.createPage.parentId ?? null,
      locale,
      description: out.description || undefined,
      content: out.content,
    });
    await this.prisma.forTenant({ tenantId: p.tenantId, userId: p.userId }).page.update({ where: { id: created.id }, data: { aiGenerated: true } });
    return { ...out, page: await this.pages.detail(p.tenantId, siteId, created.id) };
  }

  async generateBlock(p: TenantPrincipal, siteId: string, body: GenerateBlockBody) {
    const site = await this.sites.get(p.tenantId, siteId);
    const locale = body.locale ?? site.defaultLocale;
    const [voice, facts, prompt] = await Promise.all([this.content.voice(p.tenantId, siteId), this.facts(p.tenantId, siteId), this.prompts.get(p.tenantId, 'builder.generate_block')]);
    const types = body.type ? [body.type, ...(body.type === 'row' ? ['column'] : [])] : PAGE_TYPES.concat('column');

    const { system, user } = this.prompts.render(prompt, {
      siteName: voice.siteName,
      brandVoice: voice.brandVoice || 'clear, confident and helpful',
      locale,
      catalog: blockCatalogForPrompt(types),
      facts: formatFacts(facts),
      outline: body.outline?.length ? body.outline.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(empty page)',
      brief: body.type ? `${body.brief}\n\nUse block type "${body.type}".` : body.brief,
    });

    const calls: CompletionResult[] = [];
    const call = async (messages: ChatMessage[]) => {
      const res = await this.gateway.complete(
        { system: withForbidden(system, voice), messages, preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 3_000, timeoutMs: 120_000 },
        ctx(p, 'LAYOUT', prompt.id, body.pageId ? { type: 'PAGE', id: body.pageId } : undefined),
      );
      calls.push(res);
      const parsed = parseJson<{ block?: unknown; blocks?: unknown }>(res.text);
      // Models occasionally answer with the page shape; accept its first block.
      const raw = parsed?.block ?? (Array.isArray(parsed?.blocks) ? parsed.blocks[0] : undefined);
      const result = materializeBlocks(raw ? [raw] : [], { facts: factMap(facts) });
      const wrongType = body.type && result.content.root.children[0] && result.content.root.children[0].type !== body.type;
      return { text: res.text, draft: { raw, result: wrongType ? { ...result, content: { root: { ...result.content.root, children: [] } }, dropped: [{ index: 0, type: result.content.root.children[0]!.type, issues: [{ path: 'type', message: `Expected a "${body.type}" block` }] }] } : result } satisfies Draft };
    };

    const first = await call([{ role: 'user', content: user }]);
    let best = first.draft;
    let repaired = false;
    if (needsRepair(best)) {
      const second = await call([
        { role: 'user', content: user },
        { role: 'assistant', content: first.text.slice(0, 12_000) },
        { role: 'user', content: repairRequest(best, 'block') },
      ]);
      repaired = true;
      if (score(second.draft) > score(best)) best = second.draft;
    }
    const block: BlockNode | undefined = best.result.content.root.children[0];
    if (!block) throw new ApiError('AI_BAD_OUTPUT', 'The model did not return a usable block — try rephrasing', 502, { dropped: summarizeDropped(best) });
    return { block, repaired, ai: summarize(calls) };
  }

  /**
   * Rewrites every AI-editable text of one block in a single call (JSON array in, same-length array
   * out). Text leaves are mapped in place, so rich-text marks, links and fact tokens survive.
   */
  async improveBlock(p: TenantPrincipal, siteId: string, body: ImproveBlockBody) {
    const input = validatePageContent({ root: { id: '__root', type: 'section', props: {}, children: [body.block] } });
    if (!input.ok) throw badRequest('INVALID_CONTENT', 'The block is not valid', { issues: input.issues });
    const block = input.content.root.children[0]!;
    const only = body.fields ? new Set(body.fields) : null;
    const texts: string[] = [];
    mapBlockText(block, (t, f) => ((!only || only.has(f.prop)) && t.trim() && texts.push(t), t));
    if (texts.length === 0) throw badRequest('EMPTY_BLOCK', 'This block has no text to improve');

    const voice = await this.content.voice(p.tenantId, siteId);
    const prompt = await this.prompts.get(p.tenantId, 'text.rewrite');
    const goal = body.action === 'tone' ? `change the tone to: ${body.tone ?? 'friendly'}` : GOALS[body.action];
    const { system, user } = this.prompts.render(prompt, {
      siteName: voice.siteName,
      brandVoice: voice.brandVoice || 'clear and helpful',
      goal: body.instructions ? `${goal}. Additional instructions: ${body.instructions}` : goal,
      text: JSON.stringify(texts),
    });
    const res = await this.gateway.complete(
      {
        system: `${withForbidden(system, voice)}

The <text> is a JSON array of strings from one web page block (in order: e.g. title, subtitle, button label). Rewrite each element; keep leading/trailing spaces and keep each element roughly as long as allowed for its role. Respond with JSON {"texts": string[]} with exactly ${texts.length} elements in the same order.`,
        messages: [{ role: 'user', content: user }],
        preferModel: prompt.modelKey,
        responseFormat: 'json',
        maxTokens: Math.min(8_000, Math.ceil(texts.join('').length * 1.5) + 400),
        cache: 'exact',
      },
      ctx(p, 'REWRITE', prompt.id, body.pageId ? { type: 'PAGE', id: body.pageId } : undefined),
    );
    const parsed = parseJson<{ texts?: unknown }>(res.text);
    const out = Array.isArray(parsed?.texts) && parsed.texts.length === texts.length && parsed.texts.every((x) => typeof x === 'string') ? (parsed.texts as string[]) : null;
    if (!out) throw new ApiError('AI_BAD_OUTPUT', 'The model returned an unusable rewrite, please retry', 502, { model: res.model });

    let i = 0;
    const next = mapBlockText(block, (t, f) => ((!only || only.has(f.prop)) && t.trim() ? (out[i++] ?? t) : t));
    const checked = validatePageContent({ root: { id: '__root', type: 'section', props: {}, children: [next] } });
    if (!checked.ok) throw new ApiError('AI_BAD_OUTPUT', 'The rewrite did not fit the block (too long?) — try "Shorten"', 502, { issues: checked.issues.slice(0, 5) });
    return { block: checked.content.root.children[0]!, changed: texts.length, ...meta(res) };
  }

  /** Active facts visible to the site (site-scoped + tenant-wide), as citable tokens. */
  private async facts(tenantId: string, siteId: string) {
    return this.prisma.forTenant({ tenantId }).fact.findMany({
      where: { tenantId, deletedAt: null, status: 'ACTIVE', OR: [{ siteId }, { siteId: null }] },
      select: { key: true, displayValue: true, predicate: true },
      orderBy: { key: 'asc' },
      take: MAX_PROMPT_FACTS,
    });
  }

  private async screenshot(tenantId: string, siteId: string, mediaId: string): Promise<ContentPart> {
    const { media, data, mediaType } = await this.media.visionInput(tenantId, mediaId, { detail: true });
    if (media.siteId !== siteId) throw badRequest('INVALID_MEDIA', 'The reference image belongs to another site');
    return { type: 'image', mediaType, data };
  }
}

function factMap(facts: { key: string; displayValue: string }[]): Record<string, string> {
  return Object.fromEntries(facts.map((f) => [f.key, f.displayValue]));
}

function formatFacts(facts: { key: string; displayValue: string; predicate: string }[]): string {
  return facts.length ? facts.map((f) => `{{fact:${f.key}}} = ${f.displayValue} (${f.predicate})`).join('\n') : '(no facts — avoid specific figures)';
}

function needsRepair(d: Draft): boolean {
  return d.result.dropped.length > 0 || d.result.content.root.children.length === 0;
}

function score(d: Draft): number {
  return d.result.content.root.children.length * 10 - d.result.dropped.length;
}

function summarizeDropped(d: Draft) {
  return d.result.dropped.map((x) => ({ type: x.type, issues: x.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`) }));
}

function repairRequest(d: Draft, shape: 'blocks' | 'block'): string {
  const problems = d.raw === undefined ? ['The response was not valid JSON in the required shape.'] : summarizeDropped(d).map((x, i) => `${i + 1}. "${x.type}": ${x.issues.join('; ')}`);
  return [
    'Some of your output was rejected by the validator:',
    ...problems,
    '',
    shape === 'blocks'
      ? 'Return the complete corrected JSON {"title", "description", "blocks"} — keep the blocks that were fine, fix or replace the rejected ones. Use only catalog types and props.'
      : 'Return the corrected JSON {"block": …} using only catalog types and props.',
  ].join('\n');
}

function summarize(calls: CompletionResult[]) {
  const last = calls[calls.length - 1]!;
  return { ...meta(last), calls: calls.length, costUsd: calls.reduce((s, r) => s + r.costMicroUsd, 0) / 1_000_000 };
}
