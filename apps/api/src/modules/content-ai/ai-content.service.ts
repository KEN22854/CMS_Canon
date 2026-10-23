import { AiGateway, type AiCallContext, type CompletionResult } from '@canon/ai-gateway';
import { collectTextFields, mapTextFields, richTextToPlain, type PageContent, type RichTextDoc } from '@canon/blocks';
import type { Site } from '@canon/db';
import { createId } from '@paralleldrive/cuid2';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { MediaService } from '../media/media.service';
import { PagesService } from '../pages/pages.service';
import { SitesService } from '../sites/sites.service';
import type { TextAction, TextBody } from './content-ai.dto';

/** Keeps each translation call small enough for cheap models and for the JSON to come back intact. */
const TRANSLATE_CHUNK_STRINGS = 40;
const TRANSLATE_CHUNK_CHARS = 6_000;

export const GOALS: Record<Exclude<TextAction, 'tone'>, string> = {
  rewrite: 'improve clarity and flow while keeping the meaning and length',
  expand: 'expand it with one or two concrete sentences of supporting detail, without inventing facts',
  shorten: 'make it about half as long while keeping the key message',
  simplify: 'use plain language a 12-year-old understands',
  formalize: 'make it more formal and professional',
  fix: 'fix spelling, grammar and punctuation only; change nothing else',
};

export interface SiteVoice {
  siteName: string;
  brandVoice: string;
  forbidden: string[];
  glossary: { term: string; translations: Record<string, string> }[];
  defaultLocale: string;
}

/**
 * Content-facing AI features. Every call goes through the gateway (quotas, guardrails, fallback,
 * ledger) and uses versioned prompts; this service only builds inputs and validates outputs.
 * Nothing here writes AI output into live content: results are drafts or suggestions.
 */
@Injectable()
export class AiContentService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly pages: PagesService,
    private readonly media: MediaService,
  ) {}

  async text(p: TenantPrincipal, body: TextBody) {
    const voice = await this.voice(p.tenantId, body.siteId);
    const prompt = await this.prompts.get(p.tenantId, 'text.rewrite');
    const goal = body.action === 'tone' ? `change the tone to: ${body.tone ?? 'friendly'}` : GOALS[body.action];
    const { system, user } = this.prompts.render(prompt, {
      siteName: voice.siteName,
      brandVoice: voice.brandVoice || 'clear and helpful',
      goal: body.instructions ? `${goal}. Additional instructions: ${body.instructions}` : goal,
      text: body.text,
    });
    const res = await this.gateway.complete(
      {
        system: withForbidden(system, voice),
        messages: [{ role: 'user', content: user }],
        preferModel: prompt.modelKey,
        maxTokens: Math.min(4_000, Math.ceil(body.text.length / 2) + 400),
        // Degrade to the original text: the editor keeps working when every provider is down.
        degradeWith: body.text,
        cache: 'exact',
      },
      ctx(p, 'REWRITE', prompt.id, body.related),
    );
    return { text: cleanup(res.text), ...meta(res) };
  }

  async translateTexts(p: TenantPrincipal, texts: string[], targetLocale: string, siteId?: string): Promise<{ translations: string[]; results: CompletionResult[] }> {
    const voice = await this.voice(p.tenantId, siteId);
    const prompt = await this.prompts.get(p.tenantId, 'text.translate');
    const glossary = voice.glossary
      .map((g) => (g.translations[targetLocale] ? `${g.term} → ${g.translations[targetLocale]}` : `${g.term} → ${g.term} (do not translate)`))
      .join('\n');

    const out: string[] = [];
    const results: CompletionResult[] = [];
    for (const chunk of chunkTexts(texts)) {
      const { system, user } = this.prompts.render(prompt, { targetLocale, glossary: glossary || '(none)', text: JSON.stringify(chunk) });
      const res = await this.gateway.complete(
        {
          system: `${withForbidden(system, voice)}\n\nThe <text> is a JSON array of strings. Translate each element independently. Respond with JSON {"translations": string[]} with exactly ${chunk.length} elements in the same order. Keep leading/trailing spaces.`,
          messages: [{ role: 'user', content: user }],
          preferModel: prompt.modelKey,
          responseFormat: 'json',
          maxTokens: Math.min(16_000, Math.ceil(chunk.join('').length * 1.2) + 500),
          cache: 'exact',
        },
        ctx(p, 'TRANSLATE', prompt.id),
      );
      results.push(res);
      const parsed = parseJson<{ translations?: unknown }>(res.text);
      const arr = Array.isArray(parsed?.translations) ? parsed.translations : null;
      if (!arr || arr.length !== chunk.length || !arr.every((x) => typeof x === 'string')) {
        throw new ApiError('AI_BAD_OUTPUT', 'The model returned an unusable translation, please retry', 502, { model: res.model });
      }
      out.push(...(arr as string[]));
    }
    return { translations: out, results };
  }

  /**
   * Machine-translates a page into a draft in another locale (same translation group). Only text
   * leaves change: block structure, media, links and Canon fact tokens are carried over as-is.
   */
  async translatePage(p: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string, targetLocale: string, overwrite: boolean) {
    const site = await this.sites.get(p.tenantId, siteId);
    if (!site.locales.includes(targetLocale)) throw badRequest('INVALID_LOCALE', `Add "${targetLocale}" to the site locales first`);
    const source = await this.pages.get(p.tenantId, siteId, pageId);
    if (source.locale === targetLocale) throw badRequest('INVALID_LOCALE', 'Target locale equals the source locale');

    const content = source.content as unknown as PageContent;
    const leaves: string[] = [];
    mapTextFields(content, (t) => (leaves.push(t), t));
    const seo = (source.seo ?? {}) as { title?: string; description?: string };
    const head = [source.title, source.description ?? '', seo.title ?? '', seo.description ?? ''];
    const { translations, results } = await this.translateTexts(p, [...head, ...leaves], targetLocale, siteId);
    const [title, description, seoTitle, seoDescription] = translations;
    let i = 4;
    const translated = mapTextFields(content, () => translations[i++] ?? '');

    const groupId = source.translationGroupId ?? createId();
    const db = this.prisma.forTenant({ tenantId: p.tenantId, userId: p.userId });
    if (!source.translationGroupId) await db.page.update({ where: { id: source.id }, data: { translationGroupId: groupId } });

    const existing = await db.page.findFirst({ where: { siteId, translationGroupId: groupId, locale: targetLocale, deletedAt: null } });
    const seoOut = { ...(source.seo as object), ...(seoTitle ? { title: seoTitle } : {}), ...(seoDescription ? { description: seoDescription } : {}) };
    let targetId: string;
    if (existing) {
      if (!overwrite) throw conflict(`A ${targetLocale} version already exists — pass overwrite: true to replace its draft`, { pageId: existing.id });
      await this.pages.update(p, ability, siteId, existing.id, { expectedVersion: existing.version, title, description: description || null, content: translated, seo: seoOut });
      targetId = existing.id;
    } else {
      const parentId = await this.translatedParent(p.tenantId, source.parentId, targetLocale);
      const created = await this.pages.create(p, siteId, { title: title || source.title, slug: source.slug, parentId, locale: targetLocale, description: description || undefined, content: translated, seo: seoOut });
      await db.page.update({ where: { id: created.id }, data: { translationGroupId: groupId, aiGenerated: true } });
      targetId = created.id;
    }
    return {
      page: await this.pages.detail(p.tenantId, siteId, targetId),
      ai: { strings: translations.length, costUsd: results.reduce((s, r) => s + r.costMicroUsd, 0) / 1_000_000, models: [...new Set(results.map((r) => r.model))] },
    };
  }

  async seo(p: TenantPrincipal, siteId: string, pageId: string) {
    const page = await this.pages.get(p.tenantId, siteId, pageId);
    const voice = await this.voice(p.tenantId, siteId);
    const prompt = await this.prompts.get(p.tenantId, 'seo.meta');
    const text = collectTextFields(page.content as unknown as PageContent)
      .map((f) => (f.kind === 'rich' ? richTextToPlain(f.value as RichTextDoc) : (f.value as string)))
      .join('\n')
      .slice(0, 12_000);
    if (!text.trim()) throw badRequest('EMPTY_PAGE', 'Add some content to the page first');
    const { system, user } = this.prompts.render(prompt, { title: page.title, locale: page.locale, content: text });
    const res = await this.gateway.complete(
      { system: withForbidden(system, voice), messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 600, cache: 'exact' },
      ctx(p, 'SEO', prompt.id, { type: 'PAGE', id: pageId }),
    );
    const parsed = parseJson<{ title?: unknown; description?: unknown; keywords?: unknown }>(res.text);
    if (!parsed || typeof parsed.title !== 'string' || typeof parsed.description !== 'string') {
      throw new ApiError('AI_BAD_OUTPUT', 'The model returned an unusable SEO suggestion, please retry', 502);
    }
    return {
      suggestion: {
        title: parsed.title.slice(0, 70),
        description: parsed.description.slice(0, 160),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k): k is string => typeof k === 'string').slice(0, 8) : [],
      },
      ...meta(res),
    };
  }

  async altText(p: TenantPrincipal, mediaId: string, opts: { apply: boolean; locale?: string }) {
    const { media, data, mediaType } = await this.media.visionInput(p.tenantId, mediaId);
    const site = await this.sites.get(p.tenantId, media.siteId);
    const prompt = await this.prompts.get(p.tenantId, 'media.alt_text');
    const { system, user } = this.prompts.render(prompt, {
      locale: opts.locale ?? site.defaultLocale,
      context: [media.title, media.caption, media.originalName].filter(Boolean).join(' · ') || 'none',
    });
    const res = await this.gateway.complete(
      {
        system,
        messages: [{ role: 'user', content: [{ type: 'image', mediaType, data }, { type: 'text', text: user }] }],
        preferModel: prompt.modelKey,
        maxTokens: 200,
        cache: 'exact',
      },
      ctx(p, 'ALT_TEXT', prompt.id, { type: 'MEDIA', id: mediaId }),
    );
    const alt = cleanup(res.text).replace(/^(image|photo|picture) of /i, '').slice(0, 300);
    if (!alt) throw new ApiError('AI_BAD_OUTPUT', 'The model returned no description', 502);
    const updated = opts.apply ? await this.media.setGeneratedAlt(p.tenantId, mediaId, alt) : null;
    return { alt, applied: Boolean(updated), media: updated, ...meta(res) };
  }

  /** The translated page must sit under the translated parent so URLs mirror across locales. */
  private async translatedParent(tenantId: string, sourceParentId: string | null, locale: string): Promise<string | null> {
    if (!sourceParentId) return null;
    const db = this.prisma.forTenant({ tenantId });
    const parent = await db.page.findUnique({ where: { id: sourceParentId }, select: { translationGroupId: true, title: true } });
    const target = parent?.translationGroupId
      ? await db.page.findFirst({ where: { translationGroupId: parent.translationGroupId, locale, deletedAt: null }, select: { id: true } })
      : null;
    if (!target) throw conflict(`Translate the parent page "${parent?.title ?? ''}" to ${locale} first`);
    return target.id;
  }

  async voice(tenantId: string, siteId?: string): Promise<SiteVoice> {
    if (!siteId) return { siteName: 'this website', brandVoice: '', forbidden: [], glossary: [], defaultLocale: 'en' };
    const site: Site = await this.sites.get(tenantId, siteId);
    const ai = (site.aiSettings ?? {}) as { brandVoice?: string; forbiddenTopics?: string[]; glossary?: unknown };
    return { siteName: site.name, brandVoice: ai.brandVoice ?? '', forbidden: ai.forbiddenTopics ?? [], glossary: normalizeGlossary(ai.glossary), defaultLocale: site.defaultLocale };
  }
}

/**
 * Accepts both the current shape ({term, translations: {de: …}}) and the early flat one
 * ({term, de: …}) that older sites still store, so AI features never crash on legacy settings.
 */
export function normalizeGlossary(raw: unknown): SiteVoice['glossary'] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g) => {
    if (!g || typeof g !== 'object' || typeof (g as { term?: unknown }).term !== 'string') return [];
    const { term, translations, ...flat } = g as { term: string; translations?: Record<string, unknown> } & Record<string, unknown>;
    const merged = { ...flat, ...(translations ?? {}) };
    return [{ term, translations: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => typeof e[1] === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(e[0]))) }];
  });
}

export function ctx(p: TenantPrincipal, feature: AiCallContext['feature'], promptId: string, related?: AiCallContext['relatedEntity']): AiCallContext {
  return { tenantId: p.tenantId, userId: p.userId, feature, promptId, relatedEntity: related, tags: { actor: p.actorType } };
}

export function withForbidden(system: string, voice: SiteVoice): string {
  return voice.forbidden.length ? `${system}\nNever write about: ${voice.forbidden.join(', ')}.` : system;
}

export function meta(r: CompletionResult) {
  return { generationId: r.generationId, model: r.model, status: r.status, costUsd: r.costMicroUsd / 1_000_000, cacheHit: r.cacheHit };
}

/** Models sometimes wrap answers in quotes or code fences; strip only that outer packaging. */
function cleanup(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?|\n?```$/g, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .trim();
}

export function parseJson<T>(text: string): T | null {
  const s = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(s) as T;
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}

function chunkTexts(texts: string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= TRANSLATE_CHUNK_STRINGS || chars + t.length > TRANSLATE_CHUNK_CHARS)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(t);
    chars += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

