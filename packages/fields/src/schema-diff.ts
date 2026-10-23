import type { FieldDef, FieldType } from './definitions';

export interface SchemaDiff {
  added: string[];
  removed: string[];
  /** Type changes whose existing values may no longer validate. */
  retyped: { name: string; from: FieldType; to: FieldType; lossless: boolean }[];
  /** Fields that became required: existing entries keep publishing blocked until filled. */
  nowRequired: string[];
}

/** Value-preserving conversions: the stored JSON stays valid as-is. */
const LOSSLESS: Partial<Record<FieldType, FieldType[]>> = {
  text: ['textarea', 'json'],
  textarea: ['text', 'json'],
  email: ['text', 'textarea', 'json'],
  url: ['text', 'textarea', 'json'],
  select: ['text', 'textarea', 'json'],
  date: ['text', 'json'],
  color: ['text', 'json'],
  number: ['json'],
  boolean: ['json'],
  richtext: ['json'],
};

export function diffSchemas(before: readonly FieldDef[], after: readonly FieldDef[]): SchemaDiff {
  const prev = new Map(before.map((f) => [f.name, f]));
  const next = new Map(after.map((f) => [f.name, f]));
  const retyped: SchemaDiff['retyped'] = [];
  const nowRequired: string[] = [];
  for (const [name, f] of next) {
    const p = prev.get(name);
    if (!p) continue;
    const multiChanged = Boolean(p.multiple) !== Boolean(f.multiple);
    if (p.type !== f.type || multiChanged || (f.type === 'relation' && p.relation?.collectionId !== f.relation?.collectionId)) {
      retyped.push({ name, from: p.type, to: f.type, lossless: !multiChanged && p.type !== f.type && Boolean(LOSSLESS[p.type]?.includes(f.type)) });
    }
    if (f.required && !p.required) nowRequired.push(name);
  }
  return {
    added: [...next.keys()].filter((n) => !prev.has(n)),
    removed: [...prev.keys()].filter((n) => !next.has(n)),
    retyped,
    nowRequired,
  };
}
