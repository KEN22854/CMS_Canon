/** Mirrors the Prisma `AiFeature` enum; kept as a string union so this package has no DB dependency. */
export type AiFeature =
  | 'TEXT'
  | 'REWRITE'
  | 'TRANSLATE'
  | 'SEO'
  | 'ALT_TEXT'
  | 'IMAGE'
  | 'CODE'
  | 'CHAT'
  | 'EMBEDDING'
  | 'CLASSIFY'
  | 'SUMMARIZE'
  | 'FACT_CHECK'
  | 'FACT_EXTRACT'
  | 'FACT_PROPAGATE'
  | 'AGENT_STEP';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama';

/** "provider/native-model-name", e.g. "anthropic/claude-sonnet-5-5", "ollama/llama3.1:8b". */
export type ModelKey = `${ProviderId}/${string}`;

export type ModelCapability = 'text' | 'vision' | 'audio' | 'function-calling' | 'json-mode' | 'embedding';
export type ModelTier = 'economy' | 'standard' | 'premium' | 'local';

export interface ModelInfo {
  key: ModelKey;
  /** DB id (AiModel.id); undefined for models configured only via env. */
  id?: string;
  provider: ProviderId;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1M: number;
  outputPricePer1M: number;
  capabilities: readonly ModelCapability[];
  tier: ModelTier;
  embeddingDims?: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface CompletionRequest {
  /** Explicit model; omitted → tenant default. Fallback chain is appended unless `strictModel`. */
  model?: ModelKey;
  strictModel?: boolean;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  /** Mapped to provider-native knobs (Anthropic `output_config.effort`); ignored where unsupported. */
  effort?: ReasoningEffort;
  /** 'exact' is safe for any deterministic transformation; 'semantic' only for Q&A-like features. */
  cache?: 'none' | 'exact' | 'semantic';
  /**
   * Returned (status DEGRADED) when every provider fails, e.g. the original text for a rewrite.
   * Undefined → the gateway throws ALL_PROVIDERS_FAILED instead of degrading.
   */
  degradeWith?: string;
  timeoutMs?: number;
}

export interface AiCallContext {
  tenantId: string;
  userId?: string;
  feature: AiFeature;
  /** Correlates with OpenTelemetry/pino request id. */
  traceId?: string;
  promptId?: string;
  relatedEntity?: { type: 'PAGE' | 'ENTRY' | 'MEDIA' | 'FORM' | 'FACT'; id: string };
  /** Arbitrary labels forwarded to the tracer (agent run id, branch id, …). */
  tags?: Record<string, string>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'refusal' | 'content_filter' | 'other';

export type GenerationStatus = 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'DEGRADED';

export interface CompletionResult {
  generationId: string;
  text: string;
  model: ModelKey;
  status: GenerationStatus;
  usage: TokenUsage;
  /** Integer micro-USD (1e-6 $) — avoids float drift when summing millions of calls. */
  costMicroUsd: number;
  latencyMs: number;
  cacheHit: 'none' | 'exact' | 'semantic';
  fallbackUsed: boolean;
  finishReason: FinishReason;
  /** Models tried before success, with the error that made the gateway move on. */
  attempts: AttemptRecord[];
}

export interface AttemptRecord {
  model: ModelKey;
  error: string;
  retryable: boolean;
}

export type StreamEvent =
  | { type: 'start'; generationId: string; model: ModelKey }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: CompletionResult };

export interface EmbeddingRequest {
  model?: ModelKey;
  input: string[];
}

export interface EmbeddingResult {
  model: ModelKey;
  vectors: number[][];
  usage: TokenUsage;
  costMicroUsd: number;
}
