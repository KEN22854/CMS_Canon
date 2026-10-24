import { describe, expect, it } from 'vitest';
import { applyBlockPatch, assignVariant, decodeVariantKey, deviceFromUserAgent, encodeVariantKey, isBot, matchesSegment, primaryLanguage, referrerDomain, segmentRulesSchema, selectVariants, unitHash, type RuntimeConfig, type VisitorContext } from '../src';

const ctx = (over: Partial<VisitorContext> = {}): VisitorContext => ({ visitorId: 'v1', visitCount: 1, country: 'DE', device: 'mobile', language: 'de', referrerDomain: 'google.com', utmSource: null, utmMedium: null, utmCampaign: null, path: '/', ...over });

describe('request context', () => {
  it('classifies devices, bots, referrers and languages', () => {
    expect(deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130')).toBe('desktop');
    expect(isBot('Googlebot/2.1')).toBe(true);
    expect(isBot(undefined)).toBe(true);
    expect(referrerDomain('https://www.google.com/search?q=x')).toBe('google.com');
    expect(referrerDomain('https://acme.com/pricing', 'www.acme.com')).toBeNull();
    expect(primaryLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
  });
});

describe('segments', () => {
  it('evaluates all/any rules case-insensitively, with numeric and existence operators', () => {
    const rules = segmentRulesSchema.parse({ match: 'all', conditions: [{ attr: 'country', op: 'in', value: ['de', 'at', 'ch'] }, { attr: 'device', op: 'eq', value: 'mobile' }] });
    expect(matchesSegment(rules, ctx())).toBe(true);
    expect(matchesSegment(rules, ctx({ device: 'desktop' }))).toBe(false);
    const returning = segmentRulesSchema.parse({ conditions: [{ attr: 'returning', op: 'eq', value: true }] });
    expect(matchesSegment(returning, ctx({ visitCount: 3 }))).toBe(true);
    const any = segmentRulesSchema.parse({ match: 'any', conditions: [{ attr: 'utmSource', op: 'exists' }, { attr: 'visitCount', op: 'gte', value: 5 }] });
    expect(matchesSegment(any, ctx())).toBe(false);
    expect(matchesSegment(any, ctx({ utmSource: 'newsletter' }))).toBe(true);
  });

  it('rejects malformed rules', () => {
    expect(segmentRulesSchema.safeParse({ conditions: [{ attr: 'country', op: 'gte', value: 3 }] }).success).toBe(false);
    expect(segmentRulesSchema.safeParse({ conditions: [{ attr: 'country', op: 'in', value: 'de' }] }).success).toBe(false);
    expect(segmentRulesSchema.safeParse({ conditions: [] }).success).toBe(false);
  });
});

describe('assignment', () => {
  const test = { id: 't1', trafficAllocation: 1, variants: [{ id: 'control', weight: 50 }, { id: 'b', weight: 50 }] };
  it('is sticky and roughly follows the weights', () => {
    expect(assignVariant(test, 'visitor-42')).toBe(assignVariant(test, 'visitor-42'));
    const counts = { control: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) counts[assignVariant(test, `v${i}`) as 'control' | 'b']++;
    expect(counts.b / 10_000).toBeGreaterThan(0.47);
    expect(counts.b / 10_000).toBeLessThan(0.53);
  });

  it('honours traffic allocation without reshuffling those already in', () => {
    const half = { ...test, trafficAllocation: 0.5 };
    let inTest = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = assignVariant(half, `v${i}`);
      if (v) {
        inTest++;
        expect(v).toBe(assignVariant(test, `v${i}`));
      }
    }
    expect(inTest / 10_000).toBeGreaterThan(0.47);
    expect(inTest / 10_000).toBeLessThan(0.53);
    expect(unitHash('a')).not.toBe(unitHash('b'));
  });
});

describe('variant keys and selection', () => {
  it('round-trips keys and rejects tampering', () => {
    const key = encodeVariantKey({ experiments: [{ testId: 'cm1', variantId: 'b' }], segmentId: 'seg9' });
    expect(key).toBe('~t.cm1.b~s.seg9');
    expect(decodeVariantKey(key!)).toEqual({ experiments: [{ testId: 'cm1', variantId: 'b' }], segmentId: 'seg9' });
    expect(decodeVariantKey('~t.cm1.b~x.evil')).toBeNull();
    expect(decodeVariantKey('pricing')).toBeNull();
    expect(encodeVariantKey({ experiments: [], segmentId: null })).toBeNull();
  });

  it('selects experiments for the path and the first matching segment by priority', () => {
    const cfg: RuntimeConfig = {
      siteId: 's',
      version: '1',
      experiments: [{ id: 't1', pageId: 'p', path: '/pricing', locale: 'en', trafficAllocation: 1, variants: [{ id: 'control', weight: 1 }] }],
      personalization: [{ pageId: 'p', path: '/pricing', locale: 'en', segmentIds: ['dach', 'mobile'] }],
      segments: [
        { id: 'mobile', rules: { match: 'all', conditions: [{ attr: 'device', op: 'eq', value: 'mobile' }] } },
        { id: 'dach', rules: { match: 'all', conditions: [{ attr: 'country', op: 'in', value: ['de', 'at'] }] } },
      ],
    };
    expect(selectVariants(cfg, '/pricing', 'en', ctx())).toEqual({ experiments: [{ testId: 't1', variantId: 'control' }], segmentId: 'dach' });
    expect(selectVariants(cfg, '/pricing', 'en', ctx({ country: 'FR' })).segmentId).toBe('mobile');
    expect(selectVariants(cfg, '/', 'en', ctx())).toEqual({ experiments: [], segmentId: null });
  });
});

describe('block patches', () => {
  const content = { root: { id: 'root', type: 'section', props: {}, children: [{ id: 'h', type: 'hero', props: { title: 'A', subtitle: 'S' }, children: [] }, { id: 'x', type: 'cta', props: {}, children: [] }] } };
  it('overrides props, hides blocks and leaves the source untouched', () => {
    const out = applyBlockPatch(content, { h: { title: 'B' }, x: { __hidden: true } });
    expect(out.root.children).toEqual([{ id: 'h', type: 'hero', props: { title: 'B', subtitle: 'S' }, children: [] }]);
    expect(content.root.children[0]!.props.title).toBe('A');
    expect(applyBlockPatch(content, {})).toBe(content);
  });
});
