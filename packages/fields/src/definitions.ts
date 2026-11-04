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

/** "/blog", "/news/archive": lowercase segments, no trailing slash, not the site root. */
export const ROUTE_BASE_RE = /^(?:\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?){1,4}$/;

/**
 * Entry pages: every published entry is served at `${basePath}/${slug}`, rendered with the
 * template page (its `{{entry.field}}` tokens filled from the entry). A real page at the same
 * path always wins.
 */
export const collectionRouteSchema = z.object({
  basePath: z.string().regex(ROUTE_BASE_RE, 'A path like /blog (lowercase, no trailing slash)'),
  templatePageId: z.string().min(1).max(40),
});
export type CollectionRoute = z.infer<typeof collectionRouteSchema>;

export const VIEW_FILTER_OPS = ['eq', 'contains', 'empty', 'notEmpty'] as const;
export const viewFilterSchema = z.object({
  field: z.string().regex(FIELD_NAME_RE),
  op: z.enum(VIEW_FILTER_OPS),
  value: z.string().max(200).optional(),
});
export type ViewFilter = z.infer<typeof viewFilterSchema>;

/** A saved, shared filter of the entries table ("Drafts by tag news", "Out of stock"). */
export const collectionViewSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{1,24}$/),
  name: z.string().trim().min(1).max(60),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['DRAFT', 'IN_REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']).optional(),
  tag: z.string().trim().max(40).optional(),
  sort: z.enum(['updated', 'created', 'title', 'quality']).default('updated'),
  order: z.enum(['asc', 'desc']).default('desc'),
  filters: z.array(viewFilterSchema).max(5).default([]),
});
export type CollectionView = z.infer<typeof collectionViewSchema>;

/** Offline payment methods: the order is placed, money changes hands outside Canon. */
export const PAYMENT_METHODS = ['cash', 'card_on_delivery', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * A collection whose entries are products: which number field is the price (in the currency's
 * major unit, e.g. 12.50), which one counts stock (optional; empty = unlimited), how people pay.
 */
export const collectionCommerceSchema = z.object({
  priceField: z.string().regex(FIELD_NAME_RE),
  stockField: z.string().regex(FIELD_NAME_RE).optional(),
  skuField: z.string().regex(FIELD_NAME_RE).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'An ISO currency code like USD, EUR, RUB'),
  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).min(1).max(3),
  /** Who hears about new orders (besides the order list in the admin). */
  orderEmail: z.string().email().max(254).optional(),
});
export type CollectionCommerce = z.infer<typeof collectionCommerceSchema>;

export const collectionSettingsSchema = z
  .object({
    commerce: collectionCommerceSchema.optional(),
    /** Field used as the entry's display title (lists, relations, duplicates). Default: first text field. */
    titleField: z.string().regex(FIELD_NAME_RE).optional(),
    /** Field the slug is generated from on create. Default: the title field. */
    slugField: z.string().regex(FIELD_NAME_RE).optional(),
    route: collectionRouteSchema.optional(),
    views: z.array(collectionViewSchema).max(20).optional(),
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
