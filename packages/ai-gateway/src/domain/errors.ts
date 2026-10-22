import type { AttemptRecord } from './types';

export const AI_ERROR_CODES = {
  INVALID_REQUEST: 'AI_INVALID_REQUEST',
  MODEL_NOT_ALLOWED: 'AI_MODEL_NOT_ALLOWED',
  NO_CANDIDATE_MODEL: 'AI_NO_CANDIDATE_MODEL',
  QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  BLOCKED_BY_GUARDRAIL: 'AI_BLOCKED_BY_GUARDRAIL',
  ALL_PROVIDERS_FAILED: 'AI_ALL_PROVIDERS_FAILED',
} as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

/** Errors the gateway surfaces to callers; mapped to HTTP status by the API's exception filter. */
export class AiGatewayError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly details: { attempts?: AttemptRecord[]; [k: string]: unknown } = {},
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

export type ProviderErrorKind =
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'server'
  | 'auth'
  | 'bad_request'
  | 'refusal'
  | 'unknown';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limited', 'overloaded', 'timeout', 'network', 'server']);

/**
 * Normalised provider failure (anti-corruption layer: SDK error classes never leak past adapters).
 * `retryable` → retry the same model; any ProviderError → the router may move to the next model.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }

  /** Best-effort mapping from an HTTP status, shared by all adapters. */
  static fromStatus(status: number | undefined, message: string): ProviderError {
    if (status === undefined) return new ProviderError('network', message);
    if (status === 429) return new ProviderError('rate_limited', message, status);
    if (status === 529 || status === 503) return new ProviderError('overloaded', message, status);
    if (status === 408 || status === 504) return new ProviderError('timeout', message, status);
    if (status === 401 || status === 403) return new ProviderError('auth', message, status);
    if (status >= 500) return new ProviderError('server', message, status);
    if (status >= 400) return new ProviderError('bad_request', message, status);
    return new ProviderError('unknown', message, status);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}
