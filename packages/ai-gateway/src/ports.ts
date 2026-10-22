/**
 * Hexagonal ports. The gateway core depends only on these; the API wires concrete adapters
 * (Prisma, Redis, pgvector, Langfuse). Every port has an in-memory/no-op implementation in
 * ./adapters so the core is testable without infrastructure.
 */
import type {
  AiCallContext,
  AiFeature,
  ChatMessage,
  FinishReason,
  GenerationStatus,
  ModelInfo,
  ModelKey,
  ModelTier,
  ProviderId,
  ReasoningEffort,
  TokenUsage,
} from './domain/types';

// ── Providers ──────────────────────────────────────────────────────────────

export interface ProviderRequest {
  /** Provider-native model name. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  responseFormat: 'text' | 'json';
  effort?: ReasoningEffort;
  signal: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
}

export type ProviderStreamChunk = { type: 'delta'; text: string } | { type: 'end'; usage: TokenUsage; finishReason: FinishReason };

export interface LlmProvider {
  readonly id: ProviderId;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
  stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk>;
  embed?(req: { model: string; input: string[]; signal: AbortSignal }): Promise<{ vectors: number[][]; inputTokens: number }>;
}

// ── Catalog & policy ───────────────────────────────────────────────────────

export interface ModelCatalog {
  get(key: ModelKey): ModelInfo | undefined;
  list(): readonly ModelInfo[];
}

export interface GuardrailPolicy {
  piiRedaction: boolean;
  promptInjection: 'block' | 'log' | 'off';
}

export interface TenantAiPolicy {
  defaultModel: ModelKey;
  fallbackModels: ModelKey[];
  /** Empty = every active model is allowed. */
  allowedModels: ModelKey[];
  /** Plan gate on model cost class (e.g. FREE → economy + local). Undefined = all tiers. */
  allowedTiers?: ModelTier[];
  embeddingModel: ModelKey;
  guardrails: GuardrailPolicy;
}

export interface TenantPolicyProvider {
  get(tenantId: string): Promise<TenantAiPolicy>;
}

// ── Quota ──────────────────────────────────────────────────────────────────

export type QuotaDenial = { allowed: false; reason: 'budget' | 'rate' | 'tokens' | 'concurrency'; message: string; retryAfterSec?: number };
export type QuotaDecision = { allowed: true } | QuotaDenial;

export interface QuotaSlot {
  release(): Promise<void>;
}

export interface QuotaPort {
  /** Pre-flight: cheap check before spending money (rate, budget and token cap vs. estimates). */
  check(ctx: AiCallContext, estimatedMicroUsd: number, estimatedTokens: number): Promise<QuotaDecision>;
  /** Post-flight: commit actual spend; must be idempotent per generationId. */
  commit(ctx: AiCallContext, generationId: string, costMicroUsd: number, usage: TokenUsage): Promise<void>;
  /**
   * Optional in-flight slot (concurrency cap). Held from pre-flight until the call — or the
   * stream — finishes, so a tenant cannot exhaust the shared provider pool with parallel calls.
   */
  acquire?(ctx: AiCallContext): Promise<QuotaSlot | QuotaDenial>;
}

// ── Caches ─────────────────────────────────────────────────────────────────

export interface CachedCompletion {
  text: string;
  model: ModelKey;
  usage: TokenUsage;
  finishReason: FinishReason;
}

export interface ExactCachePort {
  get(tenantId: string, key: string): Promise<CachedCompletion | null>;
  set(tenantId: string, key: string, value: CachedCompletion, ttlSec: number): Promise<void>;
}

export interface SemanticCachePort {
  /** `minSimilarity` lets the degrade path accept looser matches than the normal hit path. */
  lookup(tenantId: string, query: string, feature: AiFeature, minSimilarity: number): Promise<CachedCompletion | null>;
  store(tenantId: string, query: string, feature: AiFeature, value: CachedCompletion, ttlSec: number): Promise<void>;
}

// ── Guardrails ─────────────────────────────────────────────────────────────

export type GuardrailType = 'PROMPT_INJECTION' | 'PII' | 'TOXICITY' | 'JAILBREAK' | 'OFF_TOPIC';
export type GuardrailSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface GuardrailFinding {
  type: GuardrailType;
  severity: GuardrailSeverity;
  detail: string;
}

export interface InputInspection {
  findings: GuardrailFinding[];
  block: boolean;
  /** Messages/system with PII redacted (always computed — used for persistence even when not sent). */
  redactedSystem?: string;
  redactedMessages: ChatMessage[];
}

export interface GuardrailPort {
  inspectInput(system: string | undefined, messages: ChatMessage[], policy: GuardrailPolicy): Promise<InputInspection>;
  inspectOutput(text: string, policy: GuardrailPolicy): Promise<{ findings: GuardrailFinding[]; block: boolean }>;
}

// ── Recording & tracing ────────────────────────────────────────────────────

export interface GenerationRecord {
  generationId: string;
  ctx: AiCallContext;
  model: ModelKey;
  modelId?: string;
  /** Redacted prompt as persisted — raw user input with PII never reaches storage. */
  promptText: string;
  responseText: string;
  usage: TokenUsage;
  costMicroUsd: number;
  latencyMs: number;
  cacheHit: 'none' | 'exact' | 'semantic';
  fallbackUsed: boolean;
  status: GenerationStatus;
  finishReason?: FinishReason;
  errorMessage?: string;
  guardrailFindings: GuardrailFinding[];
  guardrailAction?: 'BLOCKED' | 'MODIFIED' | 'LOGGED';
  attempts: { model: ModelKey; error: string }[];
}

export interface UsageRecorderPort {
  record(rec: GenerationRecord): Promise<void>;
}

export interface TracerPort {
  /** Fire-and-forget; implementations must buffer and never throw into the request path. */
  generation(rec: GenerationRecord & { startedAt: Date; endedAt: Date; system?: string }): void;
  flush(): Promise<void>;
}

export interface GatewayLogger {
  debug(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}
