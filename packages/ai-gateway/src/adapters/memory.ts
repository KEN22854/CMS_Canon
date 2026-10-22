import type { ModelInfo, ModelKey, TokenUsage } from '../domain/types';
import type {
  CachedCompletion,
  ExactCachePort,
  GatewayLogger,
  GenerationRecord,
  ModelCatalog,
  QuotaDecision,
  QuotaDenial,
  QuotaSlot,
  QuotaPort,
  TenantAiPolicy,
  TenantPolicyProvider,
  TracerPort,
  UsageRecorderPort,
} from '../ports';

/** In-process LRU with TTL — L1 in front of Redis in prod, the only cache in tests. */
export class MemoryExactCache implements ExactCachePort {
  private readonly map = new Map<string, { value: CachedCompletion; expiresAt: number }>();

  constructor(private readonly maxEntries = 1_000) {}

  async get(tenantId: string, key: string): Promise<CachedCompletion | null> {
    const k = `${tenantId}:${key}`;
    const entry = this.map.get(k);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(k);
      return null;
    }
    // Re-insert to mark as most recently used (Map preserves insertion order).
    this.map.delete(k);
    this.map.set(k, entry);
    return entry.value;
  }

  async set(tenantId: string, key: string, value: CachedCompletion, ttlSec: number): Promise<void> {
    const k = `${tenantId}:${key}`;
    this.map.delete(k);
    this.map.set(k, { value, expiresAt: Date.now() + ttlSec * 1000 });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export class StaticModelCatalog implements ModelCatalog {
  private readonly byKey: Map<ModelKey, ModelInfo>;

  constructor(models: readonly ModelInfo[]) {
    this.byKey = new Map(models.map((m) => [m.key, m]));
  }

  get(key: ModelKey): ModelInfo | undefined {
    return this.byKey.get(key);
  }

  list(): readonly ModelInfo[] {
    return [...this.byKey.values()];
  }
}

export class StaticPolicyProvider implements TenantPolicyProvider {
  constructor(private readonly policy: TenantAiPolicy) {}

  async get(): Promise<TenantAiPolicy> {
    return this.policy;
  }
}

/** Budget / token cap / concurrency per tenant; used by tests and single-node dev without Redis. */
export class MemoryQuota implements QuotaPort {
  readonly spent = new Map<string, number>();
  readonly tokens = new Map<string, number>();
  readonly inFlight = new Map<string, number>();
  private readonly committed = new Set<string>();

  constructor(
    private readonly budgetMicroUsd = Number.POSITIVE_INFINITY,
    private readonly opts: { tokenCap?: number; maxConcurrent?: number } = {},
  ) {}

  async check(ctx: { tenantId: string }, estimatedMicroUsd: number, estimatedTokens = 0): Promise<QuotaDecision> {
    const spent = this.spent.get(ctx.tenantId) ?? 0;
    if (spent + estimatedMicroUsd > this.budgetMicroUsd) return { allowed: false, reason: 'budget', message: 'Monthly AI budget exhausted' };
    const used = this.tokens.get(ctx.tenantId) ?? 0;
    if (this.opts.tokenCap !== undefined && used + estimatedTokens > this.opts.tokenCap) {
      return { allowed: false, reason: 'tokens', message: 'Monthly AI token allowance exhausted' };
    }
    return { allowed: true };
  }

  async commit(ctx: { tenantId: string }, generationId: string, cost: number, usage: TokenUsage): Promise<void> {
    if (this.committed.has(generationId)) return;
    this.committed.add(generationId);
    this.spent.set(ctx.tenantId, (this.spent.get(ctx.tenantId) ?? 0) + cost);
    this.tokens.set(ctx.tenantId, (this.tokens.get(ctx.tenantId) ?? 0) + usage.inputTokens + usage.outputTokens);
  }

  async acquire(ctx: { tenantId: string }): Promise<QuotaSlot | QuotaDenial> {
    const n = this.inFlight.get(ctx.tenantId) ?? 0;
    if (this.opts.maxConcurrent !== undefined && n >= this.opts.maxConcurrent) {
      return { allowed: false, reason: 'concurrency', message: 'Too many AI requests in flight' };
    }
    this.inFlight.set(ctx.tenantId, n + 1);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.inFlight.set(ctx.tenantId, (this.inFlight.get(ctx.tenantId) ?? 1) - 1);
      },
    };
  }
}

export class MemoryRecorder implements UsageRecorderPort {
  readonly records: GenerationRecord[] = [];

  async record(rec: GenerationRecord): Promise<void> {
    this.records.push(rec);
  }
}

export class NoopTracer implements TracerPort {
  generation(): void {}
  async flush(): Promise<void> {}
}

export const silentLogger: GatewayLogger = { debug() {}, warn() {}, error() {} };

