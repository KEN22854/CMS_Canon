import { z } from 'zod';
import { PAGE_SLUG_RE } from '../pages/pages.dto';
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

const pageSlug = z.string().trim().toLowerCase().regex(PAGE_SLUG_RE, 'Lowercase letters, digits and dashes');

export const generatePageBody = z.object({
  brief: z.string().trim().min(10, 'Describe the page in a sentence or two').max(4_000),
  locale: z.string().regex(LOCALE_RE).optional(),
  /** Uploaded screenshot of a layout to mirror (vision). */
  screenshotMediaId: z.string().max(40).optional(),
  /** The page being edited, for tracing/cost attribution. */
  pageId: z.string().max(40).optional(),
  /** Also create a draft page with the result (pages list → "New page with AI"). */
  createPage: z.object({ title: z.string().trim().min(1).max(200).optional(), slug: z.union([pageSlug, z.literal('')]), parentId: z.string().nullable().optional() }).optional(),
});
export type GeneratePageBody = z.infer<typeof generatePageBody>;

export const generateBlockBody = z.object({
  brief: z.string().trim().min(3).max(2_000),
  /** Restrict to one block type (e.g. the type picked in the palette). */
  type: z.string().regex(/^[a-z0-9-]+$/).max(40).optional(),
  locale: z.string().regex(LOCALE_RE).optional(),
  /** One line per existing block ("hero: Ship faster"), so the new block fits the page. */
  outline: z.array(z.string().max(200)).max(60).optional(),
  pageId: z.string().max(40).optional(),
});
export type GenerateBlockBody = z.infer<typeof generateBlockBody>;

export const improveBlockBody = z.object({
  /** The block as it is in the editor (unsaved edits included); validated before and after. */
  block: z.object({ id: z.string(), type: z.string(), props: z.record(z.string(), z.unknown()), children: z.array(z.unknown()).default([]) }),
  action: z.enum(TEXT_ACTIONS),
  tone: z.string().max(60).optional(),
  instructions: z.string().max(500).optional(),
  /** Limit to these props (e.g. one rich-text field); default: every AI-editable text in the block. */
  fields: z.array(z.string().max(60)).max(30).optional(),
  pageId: z.string().max(40).optional(),
});
export type ImproveBlockBody = z.infer<typeof improveBlockBody>;
