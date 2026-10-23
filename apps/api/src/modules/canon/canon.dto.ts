import { FACT_KEY_RE } from '@canon/blocks';
import { z } from 'zod';

export const VALUE_TYPES = ['TEXT', 'NUMBER', 'MONEY', 'PERCENT', 'DATE', 'BOOLEAN', 'URL', 'LIST'] as const;

const subjectRef = z.union([z.object({ id: z.string().min(1) }), z.object({ type: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(160) })]);

export const createFactBody = z.object({
  key: z.string().trim().toLowerCase().regex(FACT_KEY_RE, 'Use dotted lowercase keys like pro_plan.price').max(120),
  siteId: z.string().nullable().optional(),
  subject: subjectRef,
  predicate: z.string().trim().min(1).max(80),
  valueType: z.enum(VALUE_TYPES),
  value: z.record(z.string(), z.unknown()),
  /** Optional override; default is the formatted value ("$49/month"). */
  displayValue: z.string().trim().min(1).max(200).optional(),
  unit: z.string().max(40).optional(),
  expiresAt: z.coerce.date().optional(),
});
export type CreateFactBody = z.infer<typeof createFactBody>;

export const updateFactBody = z.object({
  value: z.record(z.string(), z.unknown()).optional(),
  displayValue: z.string().trim().min(1).max(200).optional(),
  unit: z.string().max(40).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISPUTED', 'DEPRECATED']).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  /** Why the value changed — shown in history and to the agents. */
  reason: z.string().max(300).optional(),
  /** When the new value became true in the world (defaults to now). */
  validFrom: z.coerce.date().optional(),
});
export type UpdateFactBody = z.infer<typeof updateFactBody>;

export const listFactsQuery = z.object({
  siteId: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'DISPUTED', 'DEPRECATED']).optional(),
});

export const propagateBody = z.object({ siteId: z.string().min(1) });

export const lintBody = z.object({ siteId: z.string().min(1), text: z.string().max(50_000) });

export const reviewChangeBody = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED', 'PROPOSED']),
  /** Manual edit of individual spans before accepting: mentionId → replacement text. */
  overrides: z.record(z.string(), z.string().max(2_000)).optional(),
});
export type ReviewChangeBody = z.infer<typeof reviewChangeBody>;

export const mergeBody = z.object({ publish: z.boolean().default(false) }).default({ publish: false });
