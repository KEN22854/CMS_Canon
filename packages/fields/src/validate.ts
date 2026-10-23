import { collectFactKeys, richTextSchema, richTextToPlain, type RichTextDoc } from '@canon/blocks';
import { z } from 'zod';
import type { FieldDef } from './definitions';

export type EntryData = Record<string, unknown>;
export type ValidationMode = 'draft' | 'publish';

export interface FieldIssue {
  field: string;
  message: string;
}

/** Stored entry data is capped so one entry can't bloat the JSONB GIN index or the delivery cache. */
export const MAX_ENTRY_BYTES = 256 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function single(f: FieldDef): z.ZodType {
  switch (f.type) {
    case 'text':
    case 'textarea': {
      let s = z.string().max(f.max ?? (f.type === 'text' ? 500 : 20_000));
      if (f.min !== undefined) s = s.min(f.min);
      return s;
    }
    case 'richtext':
      return richTextSchema;
    case 'number': {
      let n = z.number().finite();
      if (f.integer) n = n.int();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.string().regex(DATE_RE, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Not a real date');
    case 'datetime':
      return z.iso.datetime({ offset: true });
    case 'select':
      return z.enum((f.options ?? []) as [string, ...string[]]);
    case 'email':
      return z.email().max(320);
    case 'url':
      return z.url({ protocol: /^https?$/ }).max(2048);
    case 'media':
    case 'relation':
      return z.string().regex(ID_RE, 'Not a valid id');
    case 'color':
      return z.string().regex(/^#[0-9a-f]{6}$/i, 'Use #rrggbb');
    case 'json':
      return z.json();
  }
}

function fieldValue(f: FieldDef): z.ZodType {
  if (!f.multiple) return single(f);
  let arr = z.array(single(f)).max(f.max ?? 100);
  if (f.min !== undefined) arr = arr.min(f.min);
  return arr.refine((a) => new Set(a.map((v) => JSON.stringify(v))).size === a.length, 'Duplicate values');
}

/** '' / [] / null mean "no value" everywhere: forms, CSV and the API agree on emptiness. */
export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

/**
 * Field-aware emptiness: an editor's blank rich-text document (one empty paragraph) is no value,
 * otherwise a required body could be "filled" by simply focusing the editor.
 */
export function isEmptyValue(f: FieldDef, v: unknown): boolean {
  if (isEmpty(v)) return true;
  if (f.type !== 'richtext' || typeof v !== 'object') return false;
  try {
    const keys = new Set<string>();
    collectFactKeys(v as RichTextDoc, keys);
    return keys.size === 0 && richTextToPlain(v as RichTextDoc).trim() === '';
  } catch {
    return false; // malformed: let validation report it
  }
}

/**
 * Validates entry data against the collection's fields. Unknown keys are dropped (a removed
 * field's data disappears on the next save), empty values are normalised away, and `required`
 * is only enforced in publish mode so editors can save work in progress.
 */
export function validateEntryData(fields: readonly FieldDef[], input: unknown, mode: ValidationMode = 'draft'): { ok: true; data: EntryData } | { ok: false; issues: FieldIssue[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, issues: [{ field: '', message: 'Entry data must be an object' }] };
  const src = input as EntryData;
  const data: EntryData = {};
  const issues: FieldIssue[] = [];
  for (const f of fields) {
    const v = src[f.name];
    if (isEmptyValue(f, v)) {
      if (mode === 'publish' && f.required) issues.push({ field: f.name, message: `${f.label} is required` });
      continue;
    }
    const res = fieldValue(f).safeParse(typeof v === 'string' && f.type !== 'richtext' && f.type !== 'json' ? v.trim() : v);
    if (res.success) data[f.name] = res.data;
    else issues.push(...res.error.issues.slice(0, 3).map((i) => ({ field: f.name, message: i.path.length ? `${f.label} [${i.path.join('.')}]: ${i.message}` : `${f.label}: ${i.message}` })));
  }
  if (issues.length === 0 && new TextEncoder().encode(JSON.stringify(data)).length > MAX_ENTRY_BYTES) issues.push({ field: '', message: `Entry is larger than ${MAX_ENTRY_BYTES / 1024} KB` });
  return issues.length ? { ok: false, issues } : { ok: true, data };
}

/** Ids referenced by relation fields: kept in entry_relations for reverse lookups and delete protection. */
export function collectRelations(fields: readonly FieldDef[], data: EntryData): { field: string; targetId: string; position: number }[] {
  return fields
    .filter((f) => f.type === 'relation')
    .flatMap((f) => {
      const v = data[f.name];
      const ids = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
      return ids.filter((x): x is string => typeof x === 'string').map((targetId, position) => ({ field: f.name, targetId, position }));
    });
}

export function collectMedia(fields: readonly FieldDef[], data: EntryData): string[] {
  return fields
    .filter((f) => f.type === 'media')
    .flatMap((f) => {
      const v = data[f.name];
      return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
    });
}
