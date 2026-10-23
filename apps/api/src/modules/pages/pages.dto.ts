import { z } from 'zod';
import { LOCALE_RE } from '../sites/sites.dto';

export const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const slug = z.string().trim().toLowerCase().regex(PAGE_SLUG_RE, 'Lowercase letters, digits and dashes');

const seo = z
  .object({
    title: z.string().max(120),
    description: z.string().max(320),
    ogImageMediaId: z.string().max(40),
    noindex: z.boolean(),
    canonical: z.string().url().max(2048),
  })
  .partial()
  .strict();

export const createPageBody = z.object({
  title: z.string().trim().min(1).max(200),
  /** Empty only for the home page of a locale. */
  slug: z.union([slug, z.literal('')]),
  parentId: z.string().nullable().optional(),
  locale: z.string().regex(LOCALE_RE).optional(),
  description: z.string().max(500).optional(),
  content: z.unknown().optional(),
  seo: seo.optional(),
});
export type CreatePageBody = z.infer<typeof createPageBody>;

export const updatePageBody = z
  .object({
    /** Optimistic lock: the draft version the client edited. Mismatch → 409 with the current version. */
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    slug: z.union([slug, z.literal('')]).optional(),
    parentId: z.string().nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    content: z.unknown().optional(),
    seo: seo.optional(),
  })
  .strict();
export type UpdatePageBody = z.infer<typeof updatePageBody>;

export const listPagesQuery = z.object({
  status: z.enum(['DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  locale: z.string().regex(LOCALE_RE).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListPagesQuery = z.infer<typeof listPagesQuery>;

export const publishBody = z.object({ comment: z.string().max(200).optional() }).default({});
export const scheduleBody = z.object({
  at: z.coerce.date().refine((d) => d.getTime() > Date.now() + 30_000, { message: 'Schedule at least 30 seconds ahead' }),
  action: z.enum(['PUBLISH', 'UNPUBLISH']).default('PUBLISH'),
  timezone: z.string().max(64).default('UTC'),
});
export type ScheduleBody = z.infer<typeof scheduleBody>;

export const checkpointBody = z.object({ comment: z.string().max(200).optional() }).default({});

export const reorderBody = z.object({
  items: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), position: z.number().int().min(0).max(100_000) })).min(1).max(500),
});
export type ReorderBody = z.infer<typeof reorderBody>;
