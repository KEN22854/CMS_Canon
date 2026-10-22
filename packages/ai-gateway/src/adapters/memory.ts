import type { ModelInfo, ModelKey, TokenUsage } from '../domain/types';
import type {
  CachedCompletion,
  ExactCachePort,
  GatewayLogger,
  GenerationRecord,
  ModelCatalog,
  QuotaDecision,
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

/** Budget in micro-USD per tenant; used by tests and single-node dev without Redis. */
export class MemoryQuota implements QuotaPort {
  readonly spent = new Map<string, number>();
  private readonly committed = new Set<string>();

  constructor(private readonly budgetMicroUsd = Number.POSITIVE_INFINITY) {}

  async check(ctx: { tenantId: string }, estimatedMicroUsd: number): Promise<QuotaDecision> {
    const spent = this.spent.get(ctx.tenantId) ?? 0;
    return spent + estimatedMicroUsd > this.budgetMicroUsd
      ? { allowed: false, reason: 'budget', message: 'Monthly AI budget exhausted' }
      : { allowed: true };
  }

  async commit(ctx: { tenantId: string }, generationId: string, cost: number, _usage: TokenUsage): Promise<void> {
    if (this.committed.has(generationId)) return;
    this.committed.add(generationId);
    this.spent.set(ctx.tenantId, (this.spent.get(ctx.tenantId) ?? 0) + cost);
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

