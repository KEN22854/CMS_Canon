import { collectionAiSettingsSchema, collectionFieldsSchema, collectionSettingsSchema } from '@canon/fields';
import { z } from 'zod';
import { LOCALE_RE } from '../sites/sites.dto';

const collectionSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/, 'Lowercase letters, digits and dashes');
const entrySlug = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/, 'Lowercase letters, digits and dashes');
const tags = z.array(z.string().trim().min(1).max(40)).max(30);

export const createCollectionBody = z.object({
  name: z.string().trim().min(1).max(80),
  slug: collectionSlug,
  description: z.string().max(500).optional(),
  fields: collectionFieldsSchema,
  settings: collectionSettingsSchema.optional(),
  aiSettings: collectionAiSettingsSchema.optional(),
  isSingleton: z.boolean().default(false),
});
export type CreateCollectionBody = z.infer<typeof createCollectionBody>;

export const updateCollectionBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: collectionSlug.optional(),
  description: z.string().max(500).nullable().optional(),
  fields: collectionFieldsSchema.optional(),
  settings: collectionSettingsSchema.optional(),
  aiSettings: collectionAiSettingsSchema.optional(),
  /** Accept type changes that invalidate existing values (they are dropped on the entries' next save). */
  force: z.boolean().default(false),
});
export type UpdateCollectionBody = z.infer<typeof updateCollectionBody>;

export const SORTS = ['updated', 'created', 'title', 'quality'] as const;

export const listEntriesQuery = z.object({
  status: z.enum(['DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  locale: z.string().regex(LOCALE_RE).optional(),
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(40).optional(),
  sort: z.enum(SORTS).default('updated'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListEntriesQuery = z.infer<typeof listEntriesQuery>;

export const createEntryBody = z.object({
  data: z.record(z.string(), z.unknown()),
  slug: entrySlug.optional(),
  locale: z.string().regex(LOCALE_RE).optional(),
  tags: tags.optional(),
});
export type CreateEntryBody = z.infer<typeof createEntryBody>;

export const updateEntryBody = z.object({
  expectedVersion: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()).optional(),
  slug: entrySlug.optional(),
  tags: tags.optional(),
  status: z.enum(['DRAFT', 'ARCHIVED']).optional(),
});
export type UpdateEntryBody = z.infer<typeof updateEntryBody>;

export const publishEntryBody = z.object({ comment: z.string().max(200).optional() }).default({});

export const importQuery = z.object({
  format: z.enum(['csv', 'json']).optional(),
  /** create: every row is new (slug collisions get a suffix); upsert: match by slug + locale. */
  mode: z.enum(['create', 'upsert']).default('upsert'),
  dryRun: z.stringbool().default(false),
  publish: z.stringbool().default(false),
});
export type ImportQuery = z.infer<typeof importQuery>;

export const exportQuery = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  locale: z.string().regex(LOCALE_RE).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
});

export const enrichBody = z
  .object({ tasks: z.array(z.enum(['tags', 'summary', 'quality', 'embedding'])).min(1).optional(), applyTags: z.boolean().default(true) })
  .default({ applyTags: true });
export type EnrichBody = z.infer<typeof enrichBody>;

export const duplicateCheckBody = z.object({ data: z.record(z.string(), z.unknown()), locale: z.string().regex(LOCALE_RE).optional(), excludeId: z.string().optional() });
export type DuplicateCheckBody = z.infer<typeof duplicateCheckBody>;

export const suggestSchemaBody = z.object({ description: z.string().trim().min(10).max(2_000) });
