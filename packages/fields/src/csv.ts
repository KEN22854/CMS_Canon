import { emptyDoc } from '@canon/blocks';
import type { FieldDef } from './definitions';
import type { EntryData } from './validate';

/**
 * RFC 4180 CSV. Multi-values are joined with " | ", rich text and JSON are written as JSON so a
 * round-trip is lossless; on import plain text in a rich-text column becomes paragraphs.
 */
export const MULTI_SEPARATOR = ' | ';
export const META_COLUMNS = ['slug', 'locale', 'status', 'tags'] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const esc = (v: string) => (/[",\r\n]/.test(v) || /^[=+\-@\t]/.test(v) ? `"${guardFormula(v).replace(/"/g, '""')}"` : v);

/** Spreadsheet apps execute cells starting with = + - @ (CSV injection); prefix them with a quote. */
function guardFormula(v: string): string {
  return /^[=+\-@\t]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
}

export function cellOf(f: FieldDef, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(String).join(MULTI_SEPARATOR);
  if (f.type === 'richtext' || f.type === 'json') return JSON.stringify(v);
  return String(v);
}

export function toCsv(fields: readonly FieldDef[], rows: { slug: string; locale: string; status: string; tags: string[]; data: EntryData }[]): string {
  const header = [...META_COLUMNS, ...fields.map((f) => f.name)];
  const lines = [header.join(',')];
  for (const r of rows) {
    const cells = [r.slug, r.locale, r.status, r.tags.join(MULTI_SEPARATOR), ...fields.map((f) => cellOf(f, r.data[f.name]))];
    lines.push(cells.map(esc).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Turns one CSV cell into the field's JSON shape; validation (types, options) happens afterwards. */
export function parseCell(f: FieldDef, raw: string): unknown {
  const v = raw.trim();
  if (v === '') return undefined;
  if (f.multiple) return v.split('|').map((x) => scalar(f, x.trim())).filter((x) => x !== '');
  return scalar(f, v);
}

function scalar(f: FieldDef, v: string): unknown {
  switch (f.type) {
    case 'number': {
      const n = Number(v.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : v;
    }
    case 'boolean':
      return /^(true|yes|1|y|да)$/i.test(v) ? true : /^(false|no|0|n|нет)$/i.test(v) ? false : v;
    case 'richtext':
      if (v.startsWith('{')) {
        try {
          return JSON.parse(v);
        } catch {
          /* plain text that happens to start with a brace */
        }
      }
      return { type: 'doc', content: v.split(/\n{2,}/).map((p) => emptyDoc(p).content[0]!) };
    case 'json':
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    default:
      return v.startsWith("'") && /^'[=+\-@]/.test(v) ? v.slice(1) : v;
  }
}

export interface CsvRow {
  line: number;
  slug?: string;
  locale?: string;
  status?: string;
  tags: string[];
  data: EntryData;
}

/** Maps a parsed CSV (header row first) onto fields by column name; unknown columns are reported, not guessed. */
export function rowsFromCsv(fields: readonly FieldDef[], table: string[][]): { rows: CsvRow[]; unknownColumns: string[] } {
  const [header, ...body] = table;
  if (!header) return { rows: [], unknownColumns: [] };
  const names = header.map((h) => h.trim());
  const byName = new Map(fields.map((f) => [f.name, f]));
  const unknownColumns = names.filter((n) => n && !byName.has(n) && !(META_COLUMNS as readonly string[]).includes(n));
  const rows = body.map((cells, i) => {
    const row: CsvRow = { line: i + 2, tags: [], data: {} };
    names.forEach((n, j) => {
      const raw = cells[j] ?? '';
      if (n === 'slug' || n === 'locale' || n === 'status') row[n] = raw.trim() || undefined;
      else if (n === 'tags') row.tags = raw.split('|').map((t) => t.trim()).filter(Boolean);
      else {
        const f = byName.get(n);
        if (f) {
          const val = parseCell(f, raw);
          if (val !== undefined) row.data[n] = val;
        }
      }
    });
    return row;
  });
  return { rows, unknownColumns };
}
