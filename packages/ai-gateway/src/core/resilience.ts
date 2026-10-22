import CircuitBreaker from 'opossum';
import { ProviderError } from '../domain/errors';
import type { ProviderId } from '../domain/types';

export interface ResilienceOptions {
  /** Retries per model for retryable errors (rate limit, 5xx, network). */
  maxRetries: number;
  baseDelayMs: number;
  /** % of failed calls in the rolling window that opens the breaker. */
  errorThresholdPercentage: number;
  /** Minimum calls in the window before the breaker may open (avoids opening on the first blip). */
  volumeThreshold: number;
  resetTimeoutMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceOptions = {
  maxRetries: 2,
  baseDelayMs: 250,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeoutMs: 30_000,
};

type Thunk = () => Promise<unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One breaker per provider (bulkhead): an Anthropic outage must not slow down OpenAI fallbacks.
 * Client errors (400/auth/refusal) are filtered out so a malformed prompt can't trip the breaker
 * for every tenant.
 */
export class ProviderResilience {
  private readonly breakers = new Map<ProviderId, CircuitBreaker<[Thunk], unknown>>();

  constructor(private readonly opts: ResilienceOptions = DEFAULT_RESILIENCE) {}

  isOpen(provider: ProviderId): boolean {
    return this.breakers.get(provider)?.opened ?? false;
  }

  async execute<T>(provider: ProviderId, fn: () => Promise<T>): Promise<T> {
    const breaker = this.breakerFor(provider);
    let attempt = 0;
    for (;;) {
      try {
        return (await breaker.fire(fn)) as T;
      } catch (err) {
        if (breaker.opened) {
          throw new ProviderError('overloaded', `Circuit open for provider ${provider}`);
        }
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable || attempt >= this.opts.maxRetries) throw err;
        // Full jitter: spreads synchronized retries from many workers after a provider blip.
        await sleep(Math.random() * this.opts.baseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  shutdown(): void {
    for (const b of this.breakers.values()) b.shutdown();
  }

  private breakerFor(provider: ProviderId): CircuitBreaker<[Thunk], unknown> {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker<[Thunk], unknown>((fn: Thunk) => fn(), {
        // Timeouts are enforced per request via AbortSignal; a breaker timeout would orphan the request.
        timeout: false,
        errorThresholdPercentage: this.opts.errorThresholdPercentage,
        volumeThreshold: this.opts.volumeThreshold,
        resetTimeout: this.opts.resetTimeoutMs,
        errorFilter: (err: unknown) => err instanceof ProviderError && !err.retryable,
      });
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }
}

/**
 * Resolves once the first chunk arrives, so connection + time-to-first-token go through the
 * breaker/retry path while the rest of the stream is consumed outside it. Fallback is only
 * possible before the first byte reaches the client.
 */
export async function peekFirst<T>(iterable: AsyncIterable<T>): Promise<{ first: IteratorResult<T>; rest: AsyncIterator<T> }> {
  const it = iterable[Symbol.asyncIterator]();
  const first = await it.next();
  return { first, rest: it };
}
