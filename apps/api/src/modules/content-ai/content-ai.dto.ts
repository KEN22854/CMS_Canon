import { z } from 'zod';
import { LOCALE_RE } from '../sites/sites.dto';

export const TEXT_ACTIONS = ['rewrite', 'expand', 'shorten', 'tone', 'simplify', 'formalize', 'fix'] as const;
export type TextAction = (typeof TEXT_ACTIONS)[number];

export const textBody = z.object({
  action: z.enum(TEXT_ACTIONS),
  text: z.string().min(1).max(20_000),
  siteId: z.string().optional(),
  tone: z.string().max(60).optional(),
  instructions: z.string().max(500).optional(),
  related: z.object({ type: z.enum(['PAGE', 'ENTRY', 'MEDIA', 'FORM', 'FACT']), id: z.string() }).optional(),
});
export type TextBody = z.infer<typeof textBody>;

export const translateBody = z.object({
  texts: z.array(z.string().max(10_000)).min(1).max(200),
  targetLocale: z.string().regex(LOCALE_RE),
  siteId: z.string().optional(),
});
export type TranslateBody = z.infer<typeof translateBody>;

export const translatePageBody = z.object({ targetLocale: z.string().regex(LOCALE_RE), overwrite: z.boolean().default(false) });

export const altBody = z.object({ apply: z.boolean().default(false), locale: z.string().regex(LOCALE_RE).optional() }).default({ apply: false });
