import { segmentRulesSchema } from '@canon/edge';
import { z } from 'zod';

const patch = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.record(z.string().max(60), z.unknown())).refine((p) => Object.keys(p).length <= 50, 'At most 50 blocks per patch');

export const variantInput = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Lowercase id: letters, digits, - and _'),
  name: z.string().trim().min(1).max(80),
  weight: z.number().min(0).max(1_000).default(1),
  patch: patch.default({}),
});

export const createExperimentBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** Event name that counts as a conversion (e.g. "cta_click", "signup"). */
  goalMetric: z.string().regex(/^[a-z0-9_.:-]{1,60}$/i),
  trafficAllocation: z.number().min(0.01).max(1).default(1),
  /** "control" (empty patch) is added if missing — every test measures against the published page. */
  variants: z.array(variantInput).min(1).max(5),
});
export type CreateExperimentBody = z.infer<typeof createExperimentBody>;

export const updateExperimentBody = createExperimentBody.partial();
export type UpdateExperimentBody = z.infer<typeof updateExperimentBody>;

export const completeExperimentBody = z.object({
  winnerVariantId: z.string().max(40).optional(),
  /** Write the winner's patch into the page draft (publishing stays a human decision). */
  applyToDraft: z.boolean().default(false),
});

export const suggestBody = z.object({
  blockId: z.string().min(1).max(64),
  count: z.number().int().min(1).max(3).default(2),
  goal: z.string().max(200).optional(),
  /** For personalization: the segment the copy is written for. */
  segmentId: z.string().optional(),
});
export type SuggestBody = z.infer<typeof suggestBody>;

export const segmentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  rules: segmentRulesSchema,
});
export type SegmentBody = z.infer<typeof segmentBody>;

export const testSegmentBody = z.object({
  rules: segmentRulesSchema,
  context: z.object({
    country: z.string().max(2).nullable().default(null),
    device: z.enum(['mobile', 'tablet', 'desktop']).default('desktop'),
    language: z.string().max(8).nullable().default(null),
    referrerDomain: z.string().max(200).nullable().default(null),
    utmSource: z.string().max(100).nullable().default(null),
    utmMedium: z.string().max(100).nullable().default(null),
    utmCampaign: z.string().max(100).nullable().default(null),
    visitCount: z.number().int().min(1).default(1),
    path: z.string().max(500).default('/'),
  }),
});

export const personalizationBody = z.object({
  segmentId: z.string().min(1),
  priority: z.number().int().min(0).max(1_000).default(100),
  patch,
  status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE'),
});
export type PersonalizationBody = z.infer<typeof personalizationBody>;
