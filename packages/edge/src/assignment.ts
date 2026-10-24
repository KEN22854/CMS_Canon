/**
 * Deterministic experiment assignment: the same visitor always lands in the same variant, on
 * every server and at the edge, with no lookup table. FNV-1a over "testId:visitorId" gives a
 * uniform 32-bit hash; two independent slices of it decide (a) whether the visitor is in the
 * test at all (traffic allocation) and (b) which variant, so changing the allocation doesn't
 * reshuffle visitors who were already in.
 */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function unitHash(seed: string): number {
  return fnv1a(seed) / 0x1_0000_0000;
}

export interface AssignableTest {
  id: string;
  trafficAllocation: number;
  variants: { id: string; weight: number }[];
}

/** Variant id, or null when the visitor falls outside the traffic allocation (sees the original). */
export function assignVariant(test: AssignableTest, visitorId: string): string | null {
  if (!test.variants.length) return null;
  if (unitHash(`${test.id}:alloc:${visitorId}`) >= Math.min(1, Math.max(0, test.trafficAllocation))) return null;
  const total = test.variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return null;
  let r = unitHash(`${test.id}:variant:${visitorId}`) * total;
  for (const v of test.variants) {
    r -= Math.max(0, v.weight);
    if (r < 0) return v.id;
  }
  return test.variants.at(-1)!.id;
}
