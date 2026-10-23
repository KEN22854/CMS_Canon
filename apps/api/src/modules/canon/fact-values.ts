/**
 * Typed fact values: display formatting, comparison of observed vs canonical values, and the
 * deterministic half of mention detection. Money, numbers, percentages and dates compare
 * numerically — the linter needs no model to tell "$39" from "$49".
 */
export type FactValueType = 'TEXT' | 'NUMBER' | 'MONEY' | 'PERCENT' | 'DATE' | 'BOOLEAN' | 'URL' | 'ENTITY_REF' | 'LIST';

export interface FactLike {
  id: string;
  key: string;
  valueType: FactValueType;
  value: unknown;
  displayValue: string;
  unit?: string | null;
  subjectNames: string[];
}

const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', RUB: '₽', INR: '₹' };
const CODE_BY_SYMBOL: Record<string, string> = Object.fromEntries(Object.entries(SYMBOL).map(([c, s]) => [s, c]));

export function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const v = value as { amount?: unknown; value?: unknown };
    const n = typeof v.amount === 'number' ? v.amount : typeof v.value === 'number' ? v.value : null;
    return n !== null && Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'string') {
    const n = parseLooseNumber(value);
    return n;
  }
  return null;
}

/** "1,234.50" / "1.234,50" / "1 234" / "49" → number. Ambiguous separators resolve to the common reading. */
export function parseLooseNumber(raw: string): number | null {
  const s = raw.replace(/[\s  ]/g, '');
  if (!/\d/.test(s)) return null;
  let t = s.replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));

/** Canonical display string for a typed value (what BOUND tokens render). */
export function formatFactValue(type: FactValueType, value: unknown, unit?: string | null): string {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'MONEY': {
      const amount = numberOf(value);
      if (amount === null) return '';
      const code = typeof v.currency === 'string' ? v.currency.toUpperCase() : 'USD';
      const money = SYMBOL[code] ? `${SYMBOL[code]}${fmt(amount)}` : `${fmt(amount)} ${code}`;
      return typeof v.period === 'string' && v.period ? `${money}/${v.period}` : money;
    }
    case 'NUMBER': {
      const n = numberOf(value);
      return n === null ? '' : `${fmt(n)}${unit ? ` ${unit}` : ''}`;
    }
    case 'PERCENT': {
      const n = numberOf(value);
      return n === null ? '' : `${fmt(n)}%`;
    }
    case 'DATE':
      return typeof v.date === 'string' ? v.date : typeof value === 'string' ? value : '';
    case 'BOOLEAN':
      return (typeof v.value === 'boolean' ? v.value : Boolean(value)) ? 'yes' : 'no';
    case 'URL':
      return typeof v.url === 'string' ? v.url : '';
    case 'LIST':
      return Array.isArray(v.items) ? v.items.map(String).join(', ') : '';
    default:
      return typeof v.text === 'string' ? v.text : typeof value === 'string' ? value : '';
  }
}

/** Does an observed value (from the model or from text) state the canonical value? */
export function sameValue(type: FactValueType, canonical: unknown, observed: unknown): boolean {
  if (type === 'MONEY' || type === 'NUMBER' || type === 'PERCENT') {
    const a = numberOf(canonical);
    const b = numberOf(observed);
    if (a === null || b === null) return false;
    if (Math.abs(a - b) > 1e-9) return false;
    if (type === 'MONEY' && observed && typeof observed === 'object') {
      const oc = (observed as { currency?: unknown }).currency;
      const cc = (canonical as { currency?: unknown })?.currency;
      if (typeof oc === 'string' && typeof cc === 'string' && oc.toUpperCase() !== cc.toUpperCase()) return false;
    }
    return true;
  }
  const norm = (x: unknown) => formatFactValue(type, x).trim().toLowerCase();
  return norm(canonical) !== '' && norm(canonical) === norm(observed);
}

export interface DetectedSpan {
  factId: string;
  surfaceText: string;
  start: number;
  observedValue: unknown;
  inSync: boolean;
  confidence: number;
}

const MONEY_RE = /(?:([$€£¥₽₹])\s?(\d[\d.,\s]*\d|\d))|(?:(\d[\d.,\s]*\d|\d)\s?([$€£¥₽₹]|USD|EUR|GBP|usd|eur|gbp))/g;

function sentences(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  const re = /[^.!?\n]+[.!?]*/g;
  for (const m of text.matchAll(re)) out.push({ start: m.index!, text: m[0] });
  return out;
}

/**
 * Deterministic mention detection in one text field.
 * 1. The canonical display string appears verbatim → IN_SYNC.
 * 2. A money amount appears in a sentence that names the fact's subject, and the subject has a
 *    single money fact → IN_SYNC or CONFLICT by amount. Restricting to sentences that name the
 *    subject keeps "$10 off your first order" from being read as the Pro price.
 */
export function detectSpans(text: string, facts: readonly FactLike[]): DetectedSpan[] {
  const out: DetectedSpan[] = [];
  const lower = text.toLowerCase();
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  for (const f of facts) {
    const dv = f.displayValue.trim();
    if (dv.length < 2) continue;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(dv.toLowerCase(), from);
      if (i < 0) break;
      from = i + dv.length;
      // "120+" must not match inside "1120+", nor "$49" inside "$499".
      const before = text[i - 1] ?? ' ';
      const after = text[i + dv.length] ?? ' ';
      if (/[\p{L}\p{N}]/u.test(before) || /\d/.test(after)) continue;
      taken.push([i, i + dv.length]);
      out.push({ factId: f.id, surfaceText: text.slice(i, i + dv.length), start: i, observedValue: f.value, inSync: true, confidence: 0.95 });
    }
  }

  const moneyFacts = facts.filter((f) => f.valueType === 'MONEY');
  for (const s of sentences(text)) {
    const sl = s.text.toLowerCase();
    const subjects = moneyFacts.filter((f) => f.subjectNames.some((n) => n.length > 1 && sl.includes(n.toLowerCase())));
    const bySubject = new Map<string, FactLike[]>();
    for (const f of subjects) {
      const key = f.subjectNames[0]!.toLowerCase();
      bySubject.set(key, [...(bySubject.get(key) ?? []), f]);
    }
    const candidates = [...bySubject.values()].filter((list) => list.length === 1).map((l) => l[0]!);
    if (candidates.length !== 1) continue; // two subjects with prices in one sentence: leave it to the model
    const f = candidates[0]!;
    for (const m of s.text.matchAll(MONEY_RE)) {
      const start = s.start + m.index!;
      const surface = m[0].trim();
      if (overlaps(start, start + surface.length)) continue;
      const symbol = m[1] ?? m[4] ?? '';
      const amount = parseLooseNumber(m[2] ?? m[3] ?? '');
      if (amount === null) continue;
      const currency = CODE_BY_SYMBOL[symbol] ?? symbol.toUpperCase();
      const observed = { amount, currency };
      taken.push([start, start + surface.length]);
      out.push({ factId: f.id, surfaceText: surface, start, observedValue: observed, inSync: sameValue('MONEY', f.value, observed), confidence: 0.7 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Fallback rewrite when no model is available: swap the old display string, or the old number,
 * for the new value. Good enough for "$49" → "$59"; anything subtler ("under fifty") returns null
 * and is escalated to a human.
 */
export function literalSubstitution(span: string, oldDisplay: string, oldValue: unknown, next: Pick<FactLike, 'value' | 'displayValue'>, observedValue?: unknown): string | null {
  if (oldDisplay && span.includes(oldDisplay)) return span.replace(oldDisplay, next.displayValue);
  const newNum = numberOf(next.value);
  if (newNum === null) return null;
  // A CONFLICT span states some other number (the observed one), not necessarily the previous value.
  for (const target of [numberOf(oldValue), numberOf(observedValue)]) {
    if (target === null) continue;
    for (const m of span.matchAll(/\d[\d.,]*/g)) {
      if (parseLooseNumber(m[0]) === target) return span.slice(0, m.index) + fmt(newNum) + span.slice(m.index! + m[0].length);
    }
  }
  return null;
}

/** A rewrite must state the new value and must not keep stating the old one. */
export function deterministicCheck(proposed: string, oldDisplay: string, newFact: Pick<FactLike, 'valueType' | 'value' | 'displayValue'>, oldValue: unknown): { pass: boolean; issues: string[] } {
  const issues: string[] = [];
  const p = proposed.toLowerCase();
  const newNum = numberOf(newFact.value);
  const oldNum = numberOf(oldValue);
  const nums = [...proposed.matchAll(/\d[\d.,]*/g)].map((m) => parseLooseNumber(m[0])).filter((n): n is number => n !== null);
  const statesNew = p.includes(newFact.displayValue.toLowerCase()) || (newNum !== null && nums.some((n) => Math.abs(n - newNum) < 1e-9));
  if (!statesNew) issues.push(`Does not state the new value (${newFact.displayValue})`);
  if (oldDisplay && p.includes(oldDisplay.toLowerCase())) issues.push(`Still states the old value (${oldDisplay})`);
  else if (oldNum !== null && newNum !== oldNum && nums.some((n) => Math.abs(n - oldNum) < 1e-9)) issues.push(`Still contains the old number (${fmt(oldNum)})`);
  return { pass: issues.length === 0, issues };
}
