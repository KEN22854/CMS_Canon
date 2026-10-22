import { hash, verify } from '@node-rs/argon2';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';

/** OWASP 2025 argon2id baseline (m=19 MiB, t=2, p=1): ~50 ms/hash on a modern core. */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
/** zxcvbn score 3 = "safely unguessable: moderate protection from offline slow-hash scenario". */
const MIN_SCORE = 3;

const zxcvbn = new ZxcvbnFactory({
  translations: en.translations,
  graphs: common.adjacencyGraphs,
  dictionary: { ...common.dictionary, ...en.dictionary },
});

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/**
 * Pre-computed hash verified when the user does not exist, so "unknown email" and "wrong
 * password" take the same time and cannot be told apart by latency.
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('canon-timing-equaliser');
  await verifyPassword(await dummyHash, password);
}

export interface PasswordPolicyResult {
  ok: boolean;
  score: number;
  warning?: string;
  suggestions: string[];
}

/** User inputs (email, name) are penalised so "anna.smith2026" is weak for Anna Smith. */
export function checkPasswordPolicy(password: string, userInputs: string[] = []): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, score: 0, warning: `Use at least ${PASSWORD_MIN_LENGTH} characters`, suggestions: [] };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, score: 0, warning: `Use at most ${PASSWORD_MAX_LENGTH} characters`, suggestions: [] };
  }
  // Split 'ada.lovelace@acme.io' into its parts: zxcvbn only matches whole dictionary tokens.
  const inputs = [...new Set(userInputs.flatMap((u) => [u, ...u.toLowerCase().split(/[\s@._+-]+/)]).filter((x) => x.length >= 3))];
  // zxcvbn still rates "ada.lovelace2026" as 3 for Ada Lovelace; containing your own name or
  // mailbox is the first thing a targeted attacker tries, so reject it outright.
  const lowered = password.toLowerCase();
  if (inputs.some((x) => x.length >= 4 && !x.includes(' ') && lowered.includes(x))) {
    return { ok: false, score: 0, warning: 'Do not use your name or email in your password', suggestions: [] };
  }
  const r = zxcvbn.check(password, inputs);
  return {
    ok: r.score >= MIN_SCORE,
    score: r.score,
    warning: r.feedback.warning ?? undefined,
    suggestions: r.feedback.suggestions,
  };
}
