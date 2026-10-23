import { describe, expect, it } from 'vitest';
import { COLLECTION_PRESETS, collectionFieldsSchema, collectRelations, completeness, diffSchemas, entryAiText, entryTitle, normalizeTag, parseCsv, parseFields, rowsFromCsv, slugify, toCsv, validateEntryData, type FieldInput } from '../src';

const fields = parseFields([
  { name: 'title', label: 'Title', type: 'text', required: true, max: 20 },
  { name: 'body', label: 'Body', type: 'richtext' },
  { name: 'price', label: 'Price', type: 'number', min: 0 },
  { name: 'kind', label: 'Kind', type: 'select', options: ['a', 'b'], multiple: true },
  { name: 'author', label: 'Author', type: 'relation', relation: { collectionId: 'c_people' } },
  { name: 'sku', label: 'SKU', type: 'text', ai: false },
  { name: 'on', label: 'Date', type: 'date' },
] satisfies FieldInput[]);

describe('field definitions', () => {
  it('rejects duplicate, reserved and incomplete fields', () => {
    const res = collectionFieldsSchema.safeParse([
      { name: 'title', label: 'A', type: 'text' },
      { name: 'title', label: 'B', type: 'text' },
      { name: 'slug', label: 'Slug', type: 'text' },
      { name: 'pick', label: 'Pick', type: 'select' },
      { name: 'rel', label: 'Rel', type: 'relation' },
      { name: 'flag', label: 'Flag', type: 'boolean', multiple: true },
      { name: 'Bad-Name', label: 'X', type: 'text' },
    ]);
    expect(res.success).toBe(false);
    const msgs = res.error!.issues.map((i) => i.message).join(' | ');
    for (const m of ['Duplicate field name', 'reserved', 'needs options', 'target collection', 'cannot hold multiple', 'Start with a lowercase']) expect(msgs).toContain(m);
  });

  it('presets are valid', () => {
    for (const p of COLLECTION_PRESETS) expect(collectionFieldsSchema.safeParse(p.fields).success, p.id).toBe(true);
  });

  it('slugifies and normalises tags', () => {
    expect(slugify('Ünïcode — Prices & Plans!')).toBe('unicode-prices-plans');
    expect(normalizeTag('  Machine Learning ')).toBe('machine-learning');
  });
});

describe('entry validation', () => {
  it('drafts may be incomplete, publish enforces required', () => {
    expect(validateEntryData(fields, { price: 3 }, 'draft').ok).toBe(true);
    const pub = validateEntryData(fields, { price: 3, title: '  ' }, 'publish');
    expect(pub.ok).toBe(false);
    if (!pub.ok) expect(pub.issues).toEqual([{ field: 'title', message: 'Title is required' }]);
  });

  it('checks types, options and limits; drops unknown keys and empties', () => {
    const bad = validateEntryData(fields, { title: 'x'.repeat(21), price: -1, kind: ['a', 'z'], on: '2026-02-31x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect([...new Set(bad.issues.map((i) => i.field))].sort()).toEqual(['kind', 'on', 'price', 'title']);
    const good = validateEntryData(fields, { title: ' Hi ', kind: ['a', 'b'], hacker: '<script>', price: '', sku: 'S-1' });
    expect(good).toEqual({ ok: true, data: { title: 'Hi', kind: ['a', 'b'], sku: 'S-1' } });
  });

  it('treats a blank rich-text document as empty (required can not be satisfied by focusing the editor)', () => {
    const blank = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    const req = parseFields([{ name: 'body', label: 'Body', type: 'richtext', required: true }]);
    expect(validateEntryData(req, { body: blank }, 'publish')).toEqual({ ok: false, issues: [{ field: 'body', message: 'Body is required' }] });
    expect(validateEntryData(req, { body: blank }, 'draft')).toEqual({ ok: true, data: {} });
    const factOnly = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'factRef', attrs: { factKey: 'pro.price' } }] }] };
    expect(validateEntryData(req, { body: factOnly }, 'publish').ok).toBe(true);
  });

  it('rejects raw HTML in rich text and duplicate multi values', () => {
    expect(validateEntryData(fields, { body: { type: 'doc', content: [{ type: 'html', html: '<b>' }] } }).ok).toBe(false);
    expect(validateEntryData(fields, { kind: ['a', 'a'] }).ok).toBe(false);
  });

  it('collects relations for the reverse index', () => {
    expect(collectRelations(fields, { author: 'e_12345678' })).toEqual([{ field: 'author', targetId: 'e_12345678', position: 0 }]);
  });
});

describe('text helpers', () => {
  const data = { title: 'Pro plan', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fast and secure.' }] }] }, sku: 'SECRET-42', price: 49 };
  it('builds titles and AI text without ai:false fields or ids', () => {
    expect(entryTitle(fields, {}, data)).toBe('Pro plan');
    const t = entryAiText(fields, { ...data, author: 'e_12345678' });
    expect(t).toContain('Body: Fast and secure.');
    expect(t).toContain('Price: 49');
    expect(t).not.toContain('SECRET');
    expect(t).not.toContain('e_12345678');
  });
  it('weights required fields double in completeness', () => {
    const c = completeness(fields, { title: 'x' });
    expect(c.score).toBeCloseTo(2 / 8);
    expect(c.missing).toContain('body');
  });
});

describe('CSV', () => {
  it('round-trips quoting, multi values, rich text and guards formulas', () => {
    const csv = toCsv(fields, [
      { slug: 'pro', locale: 'en', status: 'DRAFT', tags: ['saas', 'b2b'], data: { title: 'Pro, "best"', kind: ['a', 'b'], price: 49, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Line' }] }] } } },
      { slug: 'evil', locale: 'en', status: 'DRAFT', tags: [], data: { title: '=HYPERLINK("x")' } },
    ]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    const { rows, unknownColumns } = rowsFromCsv(fields, parseCsv(csv));
    expect(unknownColumns).toEqual([]);
    expect(rows[0]).toMatchObject({ slug: 'pro', tags: ['saas', 'b2b'], data: { title: 'Pro, "best"', kind: ['a', 'b'], price: 49 } });
    expect(validateEntryData(fields, rows[0]!.data).ok).toBe(true);
    expect(rows[1]!.data.title).toBe('=HYPERLINK("x")');
  });

  it('accepts plain text for rich text, localized booleans/numbers and reports unknown columns', () => {
    const f2 = parseFields([{ name: 'body', label: 'Body', type: 'richtext' }, { name: 'ok', label: 'OK', type: 'boolean' }, { name: 'n', label: 'N', type: 'number' }]);
    const { rows, unknownColumns } = rowsFromCsv(f2, parseCsv('slug,body,ok,n,extra\r\nx,"Para one\n\nPara two",да,"1 234,5",?\n'));
    expect(unknownColumns).toEqual(['extra']);
    expect(rows[0]!.data).toMatchObject({ ok: true, n: 1234.5 });
    expect((rows[0]!.data.body as { content: unknown[] }).content).toHaveLength(2);
  });

  it('fails loudly on broken quoting', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/Unterminated/);
  });
});

describe('schema diff', () => {
  it('classifies changes', () => {
    const next = parseFields([
      { name: 'title', label: 'Title', type: 'textarea', required: true },
      { name: 'price', label: 'Price', type: 'text' },
      { name: 'kind', label: 'Kind', type: 'select', options: ['a', 'b'] },
      { name: 'sku', label: 'SKU', type: 'text', required: true },
      { name: 'extra', label: 'Extra', type: 'text' },
    ]);
    const d = diffSchemas(fields, next);
    expect(d.added).toEqual(['extra']);
    expect(d.removed.sort()).toEqual(['author', 'body', 'on']);
    expect(d.retyped).toEqual([
      { name: 'title', from: 'text', to: 'textarea', lossless: true },
      { name: 'price', from: 'number', to: 'text', lossless: false },
      { name: 'kind', from: 'select', to: 'select', lossless: false },
    ]);
    expect(d.nowRequired).toEqual(['sku']);
  });
});

describe('duplicate similarity', () => {
  it('scores copies high, rewrites medium and unrelated text near zero', async () => {
    const { textSimilarity, keywords } = await import('../src');
    const a = 'Our Pro plan includes unlimited projects, priority support and single sign-on for every team member.';
    expect(textSimilarity(a, a)).toBe(1);
    expect(textSimilarity(a, `Intro paragraph about the company. ${a} And a closing remark.`)).toBeGreaterThan(0.7);
    expect(textSimilarity(a, 'Bananas are an excellent source of potassium and fibre for athletes.')).toBeLessThan(0.05);
    expect(keywords(`${a} unlimited unlimited`)[0]).toBe('unlimited');
  });
});
