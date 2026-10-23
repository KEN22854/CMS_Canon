import { richTextToPlain, type RichTextDoc } from '@canon/blocks';
import { TEXT_TYPES, titleFieldOf, type CollectionSettings, type FieldDef } from './definitions';
import { isEmptyValue, type EntryData } from './validate';

/** One value as human-readable text (lists, CSV previews, AI input). */
export function valueToText(f: FieldDef, v: unknown, facts: Readonly<Record<string, string>> = {}): string {
  if (isEmptyValue(f, v)) return '';
  if (Array.isArray(v)) return v.map((x) => valueToText({ ...f, multiple: false }, x, facts)).join(', ');
  switch (f.type) {
    case 'richtext':
      return richTextToPlain(v as RichTextDoc, facts);
    case 'boolean':
      return v ? 'yes' : 'no';
    case 'json':
      return JSON.stringify(v);
    default:
      return String(v);
  }
}

export function entryTitle(fields: readonly FieldDef[], settings: CollectionSettings, data: EntryData, fallback = 'Untitled'): string {
  const f = titleFieldOf(fields, settings);
  const t = f ? valueToText(f, data[f.name]).trim() : '';
  return (t || fallback).slice(0, 200);
}

/**
 * Labelled plain text of the AI-eligible fields, in schema order. This is what enrichment prompts,
 * embeddings and duplicate checks see — ids, codes and fields marked `ai: false` never leave.
 */
export function entryAiText(fields: readonly FieldDef[], data: EntryData, maxChars = 12_000): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (!f.ai || f.type === 'media' || f.type === 'relation' || f.type === 'json') continue;
    const t = valueToText(f, data[f.name]).trim();
    if (t) parts.push(TEXT_TYPES.has(f.type) && t.length > 80 ? `${f.label}:\n${t}` : `${f.label}: ${t}`);
  }
  return parts.join('\n\n').slice(0, maxChars);
}

/**
 * Share of fields filled, required ones weighted double — the deterministic half of the quality
 * score; the AI half judges what a formula can't (clarity, specificity, tone).
 */
export function completeness(fields: readonly FieldDef[], data: EntryData): { score: number; missing: string[] } {
  if (fields.length === 0) return { score: 1, missing: [] };
  let total = 0;
  let got = 0;
  const missing: string[] = [];
  for (const f of fields) {
    const w = f.required ? 2 : 1;
    total += w;
    if (isEmptyValue(f, data[f.name])) missing.push(f.name);
    else got += w;
  }
  return { score: got / total, missing };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);

function shingles(s: string, n = 3): Set<string> {
  const w = words(s);
  if (w.length < n) return new Set(w.length ? [w.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i <= w.length - n; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/**
 * Near-duplicate score in [0, 1]: Jaccard over word 3-shingles (containment for very different
 * lengths, so a copy pasted into a longer entry still scores high). Deterministic and free — the
 * baseline duplicate detection works without any AI provider.
 */
export function textSimilarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return Math.max(jaccard, Math.min(A.size, B.size) >= 8 ? containment * 0.9 : 0);
}

/** Most frequent meaningful words — the full-text query used to find duplicate candidates. */
export function keywords(text: string, max = 12): string[] {
  const counts = new Map<string, number>();
  for (const w of words(text)) if (w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, max).map(([w]) => w);
}
