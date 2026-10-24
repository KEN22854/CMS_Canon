import { z } from 'zod';
import type { VisitorContext } from './context';

export const SEGMENT_ATTRIBUTES = ['country', 'device', 'language', 'referrerDomain', 'utmSource', 'utmMedium', 'utmCampaign', 'visitCount', 'returning', 'path'] as const;
export type SegmentAttribute = (typeof SEGMENT_ATTRIBUTES)[number];
export const SEGMENT_OPERATORS = ['eq', 'neq', 'in', 'notIn', 'contains', 'startsWith', 'gte', 'lte', 'exists'] as const;

export const conditionSchema = z
  .object({
    attr: z.enum(SEGMENT_ATTRIBUTES),
    op: z.enum(SEGMENT_OPERATORS),
    value: z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(100)).max(100)]).optional(),
  })
  .superRefine((c, ctx) => {
    const numeric = c.attr === 'visitCount';
    if ((c.op === 'gte' || c.op === 'lte') && !numeric) ctx.addIssue({ code: 'custom', message: `${c.op} only applies to visitCount` });
    if ((c.op === 'in' || c.op === 'notIn') && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: `${c.op} needs a list of values` });
    if (c.op !== 'exists' && c.value === undefined) ctx.addIssue({ code: 'custom', message: 'value is required' });
  });
export type SegmentCondition = z.infer<typeof conditionSchema>;

export const segmentRulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).min(1).max(10),
});
export type SegmentRules = z.infer<typeof segmentRulesSchema>;

function attribute(ctx: VisitorContext, attr: SegmentAttribute): string | number | boolean | null {
  switch (attr) {
    case 'returning':
      return ctx.visitCount > 1;
    case 'visitCount':
      return ctx.visitCount;
    default:
      return ctx[attr] ?? null;
  }
}

/** Case-insensitive for strings: "DE" and "de" are the same country to a marketer. */
function test(c: SegmentCondition, actual: string | number | boolean | null): boolean {
  if (c.op === 'exists') return actual !== null && actual !== '';
  if (actual === null) return c.op === 'neq' || c.op === 'notIn';
  const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);
  const a = norm(actual);
  switch (c.op) {
    case 'eq':
      return a === norm(c.value);
    case 'neq':
      return a !== norm(c.value);
    case 'in':
      return (c.value as string[]).map(norm).includes(a);
    case 'notIn':
      return !(c.value as string[]).map(norm).includes(a);
    case 'contains':
      return typeof a === 'string' && a.includes(String(norm(c.value)));
    case 'startsWith':
      return typeof a === 'string' && a.startsWith(String(norm(c.value)));
    case 'gte':
      return typeof a === 'number' && a >= Number(c.value);
    case 'lte':
      return typeof a === 'number' && a <= Number(c.value);
  }
}

export function matchesSegment(rules: SegmentRules, ctx: VisitorContext): boolean {
  const results = rules.conditions.map((c) => test(c, attribute(ctx, c.attr)));
  return rules.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}
