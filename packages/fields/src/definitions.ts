import { z } from 'zod';

/**
 * A collection's schema is data (stored in collections.schema), so it is itself validated by a
 * meta-schema. Everything downstream — entry validation, the admin's dynamic forms, CSV import,
 * AI enrichment text — is derived from these definitions, never hand-written per collection.
 */
export const FIELD_TYPES = ['text', 'textarea', 'richtext', 'number', 'boolean', 'date', 'datetime', 'select', 'email', 'url', 'media', 'relation', 'color', 'json'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Types that may hold several values (stored as arrays). */
export const MULTI_TYPES: ReadonlySet<FieldType> = new Set(['select', 'media', 'relation']);
/** Types whose text feeds AI enrichment (summary, tags, quality, duplicates). */
export const TEXT_TYPES: ReadonlySet<FieldType> = new Set(['text', 'textarea', 'richtext']);

/** Entry columns, not data fields — a field with one of these names would shadow them in APIs and CSV. */
export const RESERVED_FIELD_NAMES = new Set(['id', 'slug', 'status', 'locale', 'tags', 'version', 'createdAt', 'updatedAt', 'publishedAt', 'summary', 'qualityScore']);

export const FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;

export const fieldSchema = z.object({
  name: z.string().regex(FIELD_NAME_RE, 'Start with a lowercase letter; letters, digits and _ only (max 40)'),
  label: z.string().trim().min(1).max(80),
  type: z.enum(FIELD_TYPES),
  /** Enforced on publish; drafts may be incomplete. */
  required: z.boolean().default(false),
  /** Unique among the collection's live entries in the same locale. */
  unique: z.boolean().default(false),
  helpText: z.string().max(300).default(''),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  multiple: z.boolean().default(false),
  /** text/textarea: length; number: value; multiple: item count. */
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().default(false),
  relation: z.object({ collectionId: z.string().min(1).max(40) }).optional(),
  /** Include in AI enrichment input (off for internal notes, SKUs, codes…). */
  ai: z.boolean().default(true),
});
export type FieldDef = z.infer<typeof fieldSchema>;
export type FieldInput = z.input<typeof fieldSchema>;

export const collectionFieldsSchema = z
  .array(fieldSchema)
  .max(60)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path: [i, ...path] });
      if (seen.has(f.name)) issue(`Duplicate field name "${f.name}"`, ['name']);
      seen.add(f.name);
      if (RESERVED_FIELD_NAMES.has(f.name)) issue(`"${f.name}" is reserved`, ['name']);
      if (f.type === 'select' && !f.options?.length) issue('A select field needs options', ['options']);
      if (f.type === 'relation' && !f.relation) issue('A relation field needs a target collection', ['relation']);
      if (f.multiple && !MULTI_TYPES.has(f.type)) issue(`"${f.type}" fields cannot hold multiple values`, ['multiple']);
      if (f.unique && (f.multiple || !['text', 'email', 'url', 'number', 'date'].includes(f.type))) issue('Only single text, email, url, number or date fields can be unique', ['unique']);
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) issue('min is greater than max', ['min']);
    });
  });

export const collectionSettingsSchema = z
  .object({
    /** Field used as the entry's display title (lists, relations, duplicates). Default: first text field. */
    titleField: z.string().regex(FIELD_NAME_RE).optional(),
    /** Field the slug is generated from on create. Default: the title field. */
    slugField: z.string().regex(FIELD_NAME_RE).optional(),
  })
  .default({});
export type CollectionSettings = z.infer<typeof collectionSettingsSchema>;

export const collectionAiSettingsSchema = z
  .object({
    autoTag: z.boolean().default(false),
    autoSummary: z.boolean().default(false),
    qualityScore: z.boolean().default(false),
    duplicateCheck: z.boolean().default(true),
    /** Closed tag vocabulary; empty = the model may propose new tags (normalised). */
    tagVocabulary: z.array(z.string().trim().min(1).max(40)).max(200).default([]),
    maxTags: z.number().int().min(1).max(15).default(5),
  })
  .default({ autoTag: false, autoSummary: false, qualityScore: false, duplicateCheck: true, tagVocabulary: [], maxTags: 5 });
export type CollectionAiSettings = z.infer<typeof collectionAiSettingsSchema>;

export function parseFields(input: unknown): FieldDef[] {
  return collectionFieldsSchema.parse(input);
}

export function titleFieldOf(fields: readonly FieldDef[], settings: CollectionSettings = {}): FieldDef | undefined {
  return fields.find((f) => f.name === settings.titleField) ?? fields.find((f) => f.type === 'text');
}

/** Lowercase, dash-separated, 1–80 chars; the same rule pages use. */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '') || 'entry'
  );
}

/** Tags are compared case- and accent-insensitively; stored lowercased with single dashes. */
export function normalizeTag(tag: string): string {
  return slugify(tag).slice(0, 40);
}
