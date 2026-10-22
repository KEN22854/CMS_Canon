/**
 * Serialises an embedding to pgvector's text literal. Values are validated because the result
 * is cast inside raw SQL (`${literal}::vector`) — a NaN would otherwise surface as an opaque
 * Postgres error far from its cause.
 */
export function toPgVector(embedding: readonly number[]): string {
  for (const v of embedding) {
    if (!Number.isFinite(v)) {
      throw new Error('toPgVector: embedding contains a non-finite value');
    }
  }
  return `[${embedding.join(',')}]`;
}
