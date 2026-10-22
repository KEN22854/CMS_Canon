import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token; 32 bytes = 256 bits, far beyond online/offline guessing. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens we mail or hand out (refresh, reset, invite, API keys) are high-entropy, so a fast
 * SHA-256 is the right hash: slow KDFs only matter for low-entropy secrets like passwords.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
