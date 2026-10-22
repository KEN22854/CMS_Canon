import { isModelKey, type ModelKey } from '@canon/ai-gateway';
import { z } from 'zod';

const modelKey = z.string().refine(isModelKey, { message: 'expected "<provider>/<model>"' }).transform((v) => v as ModelKey);

const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(200_000) }),
  z.object({
    type: z.literal('image'),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    // ~5 MB of base64; larger images go through media upload + reference (Phase 2).
    data: z.string().max(7_000_000),
  }),
]);

const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().min(1).max(200_000), z.array(contentPart).min(1).max(20)]),
});

/** Features callable directly over the public AI API; internal ones (FACT_*, AGENT_STEP) are not. */
export const PUBLIC_FEATURES = ['TEXT', 'REWRITE', 'TRANSLATE', 'SEO', 'SUMMARIZE', 'CHAT', 'CLASSIFY', 'CODE', 'ALT_TEXT'] as const;

export const completeBody = z.object({
  feature: z.enum(PUBLIC_FEATURES).default('TEXT'),
  model: modelKey.optional(),
  strictModel: z.boolean().optional(),
  system: z.string().max(50_000).optional(),
  messages: z.array(message).min(1).max(100),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  cache: z.enum(['none', 'exact', 'semantic']).optional(),
  degradeWith: z.string().max(200_000).optional(),
  relatedEntity: z.object({ type: z.enum(['PAGE', 'ENTRY', 'MEDIA', 'FORM', 'FACT']), id: z.string().min(1) }).optional(),
});
export type CompleteBody = z.infer<typeof completeBody>;

export const embedBody = z.object({
  model: modelKey.optional(),
  input: z.array(z.string().min(1).max(30_000)).min(1).max(100),
});
export type EmbedBody = z.infer<typeof embedBody>;
