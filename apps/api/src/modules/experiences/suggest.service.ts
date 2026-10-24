import { AiGateway } from '@canon/ai-gateway';
import { getBlock, richTextToPlain, type PageContent, type RichTextDoc } from '@canon/blocks';
import type { BlockPatch, SegmentRules } from '@canon/edge';
import { Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, notFound } from '../../common/http/api-error';
import { AiContentService, ctx, meta, parseJson, withForbidden } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { PagesService } from '../pages/pages.service';
import type { SuggestBody } from './experiences.dto';
import { PatchValidator } from './patch-validator';
import { PersonalizationService } from './personalization.service';

/** Describes a segment's rules in words, so the copywriter knows who it writes for. */
export function describeRules(rules: SegmentRules): string {
  const parts = rules.conditions.map((c) => `${c.attr} ${c.op} ${Array.isArray(c.value) ? c.value.join('/') : (c.value ?? '')}`.trim());
  return parts.join(rules.match === 'all' ? ' AND ' : ' OR ');
}

/**
 * AI copy for experiments and personalization: alternative texts for one block's plain text
 * fields (headline, subtitle, button label), returned as ready-to-use, *validated* patches.
 * Rich-text and media are left alone — a variant should test one idea, not rewrite the page.
 */
@Injectable()
export class SuggestService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly content: AiContentService,
    private readonly pages: PagesService,
    private readonly patches: PatchValidator,
    private readonly personalization: PersonalizationService,
  ) {}

  async suggest(p: TenantPrincipal, siteId: string, pageId: string, body: SuggestBody) {
    const page = await this.pages.get(p.tenantId, siteId, pageId);
    const base = await this.patches.baseContent(page);
    const block = find(base, body.blockId);
    if (!block) throw notFound('Block');
    const def = getBlock(block.type);
    const fields = Object.entries(def?.fields ?? {}).filter(([, f]) => f.ai && (f.kind === 'text' || f.kind === 'textarea'));
    const texts = Object.fromEntries(fields.flatMap(([k]) => (typeof block.props[k] === 'string' && (block.props[k] as string).trim() ? [[k, block.props[k] as string]] : [])));
    if (!Object.keys(texts).length) throw badRequest('NO_TEXT', 'This block has no short text fields to vary');
    const audience = body.segmentId ? await this.personalization.segment(p.tenantId, siteId, body.segmentId) : null;
    const voice = await this.content.voice(p.tenantId, siteId);
    const prompt = await this.prompts.get(p.tenantId, 'experiments.suggest_variants');
    const context = base.root.children
      .slice(0, 8)
      .map((b) => `${b.type}: ${Object.values(b.props).filter((v): v is string => typeof v === 'string').join(' / ').slice(0, 200) || (b.props.doc ? richTextToPlain(b.props.doc as RichTextDoc).slice(0, 200) : '')}`)
      .join('\n');
    const { system, user } = this.prompts.render(prompt, {
      brandVoice: voice.brandVoice || 'clear and helpful',
      locale: page.locale,
      count: body.count,
      goal: body.goal ?? 'more visitors take the next step',
      audience: audience ? `${audience.name}${audience.description ? ` — ${audience.description}` : ''} (${describeRules(audience.rules as SegmentRules)})` : 'all visitors',
      blockType: block.type,
      texts: JSON.stringify(texts),
      page: context,
    });
    const res = await this.gateway.complete({ system: withForbidden(system, voice), messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 900 }, ctx(p, 'REWRITE', prompt.id, { type: 'PAGE', id: pageId }));
    const out = parseJson<{ variants?: unknown }>(res.text);
    const list = Array.isArray(out?.variants) ? out.variants : [];
    const variants: { name: string; hypothesis: string; patch: BlockPatch }[] = [];
    for (const raw of list.slice(0, body.count)) {
      const v = raw as { name?: unknown; hypothesis?: unknown; texts?: unknown };
      if (!v.texts || typeof v.texts !== 'object') continue;
      // Only fields that existed and are strings: the model can't add props or change types.
      const props = Object.fromEntries(Object.entries(v.texts as Record<string, unknown>).filter(([k, val]) => k in texts && typeof val === 'string' && val.trim()).map(([k, val]) => [k, (val as string).trim()]));
      if (!Object.keys(props).length) continue;
      const patch: BlockPatch = { [block.id]: props };
      try {
        await this.patches.validate(base, patch, 'Suggestion');
      } catch {
        continue; // too long for the block, etc.: drop rather than hand back a broken variant
      }
      variants.push({ name: typeof v.name === 'string' ? v.name.slice(0, 60) : `Variant ${variants.length + 1}`, hypothesis: typeof v.hypothesis === 'string' ? v.hypothesis.slice(0, 300) : '', patch });
    }
    if (!variants.length) throw new ApiError('AI_BAD_OUTPUT', 'The model did not return usable variants — try again', 502);
    return { blockId: block.id, original: texts, variants, ai: meta(res) };
  }
}

function find(content: PageContent, id: string) {
  const walk = (n: PageContent['root']): PageContent['root'] | null => (n.id === id ? n : n.children.map(walk).find(Boolean) ?? null);
  return walk(content.root);
}
