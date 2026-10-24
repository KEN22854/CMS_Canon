import { assignVariant, type AssignableTest } from './assignment';
import type { VisitorContext } from './context';
import { matchesSegment, type SegmentRules } from './segments';

/**
 * The proxy rewrites a request to a cache key that names the variant it renders:
 *   /s/<host>/~t.<testId>.<variantId>~s.<segmentId>/<path>
 * Every combination is its own ISR entry, so experiments and personalization stay static —
 * the cache holds one copy per variant, not one per visitor.
 */
export interface VariantSelection {
  experiments: { testId: string; variantId: string }[];
  segmentId: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeVariantKey(sel: VariantSelection): string | null {
  const parts = [...sel.experiments.filter((e) => ID.test(e.testId) && ID.test(e.variantId)).map((e) => `t.${e.testId}.${e.variantId}`), ...(sel.segmentId && ID.test(sel.segmentId) ? [`s.${sel.segmentId}`] : [])];
  return parts.length ? `~${parts.join('~')}` : null;
}

export function decodeVariantKey(segment: string | undefined): VariantSelection | null {
  if (!segment?.startsWith('~')) return null;
  const sel: VariantSelection = { experiments: [], segmentId: null };
  for (const part of segment.slice(1).split('~')) {
    const [kind, a, b] = part.split('.');
    if (kind === 't' && a && b && ID.test(a) && ID.test(b)) sel.experiments.push({ testId: a, variantId: b });
    else if (kind === 's' && a && ID.test(a)) sel.segmentId = a;
    else return null; // a tampered key renders the original page, never an error
  }
  return sel;
}

/** What the delivery API hands the proxy for one site (small, cached for seconds). */
export interface RuntimeConfig {
  siteId: string;
  version: string;
  experiments: (AssignableTest & { pageId: string; path: string; locale: string })[];
  personalization: { pageId: string; path: string; locale: string; segmentIds: string[] }[];
  segments: { id: string; rules: SegmentRules }[];
}

/**
 * Decides, for one request, which experiment variants and which segment apply. Only pages with
 * a running experiment or personalization get a variant key; everything else keeps the shared
 * cache entry. At most one segment per page (the first matching by priority) keeps the number of
 * cached copies bounded.
 */
export function selectVariants(cfg: RuntimeConfig, path: string, locale: string, ctx: VisitorContext): VariantSelection {
  const experiments = cfg.experiments
    .filter((t) => t.path === path && t.locale === locale)
    .flatMap((t) => {
      const variantId = assignVariant(t, ctx.visitorId);
      return variantId ? [{ testId: t.id, variantId }] : [];
    });
  const rules = cfg.personalization.find((p) => p.path === path && p.locale === locale);
  let segmentId: string | null = null;
  if (rules) {
    const byId = new Map(cfg.segments.map((s) => [s.id, s.rules]));
    segmentId = rules.segmentIds.find((id) => {
      const r = byId.get(id);
      return r ? matchesSegment(r, ctx) : false;
    }) ?? null;
  }
  return { experiments, segmentId };
}
