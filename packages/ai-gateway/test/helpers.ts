import {
  AiGateway,
  HeuristicGuardrails,
  MemoryExactCache,
  MemoryQuota,
  MemoryRecorder,
  NoopTracer,
  ProviderError,
  StaticModelCatalog,
  StaticPolicyProvider,
  silentLogger,
  type AiGatewayOptions,
  type LlmProvider,
  type ModelInfo,
  type ProviderId,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamChunk,
  type TenantAiPolicy,
} from '../src';

export const MODELS: ModelInfo[] = [
  { key: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', name: 'claude-sonnet-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: 2, outputPricePer1M: 10, capabilities: ['text', 'vision', 'json-mode'], tier: 'standard' },
  { key: 'anthropic/claude-haiku-5-5', provider: 'anthropic', name: 'claude-haiku-5-5', contextWindow: 1_000_000, maxOutputTokens: 128_000, inputPricePer1M: 0.1, outputPricePer1M: 0.5, capabilities: ['text', 'vision', 'json-mode'], tier: 'economy' },
  { key: 'openai/gpt-4o-mini', provider: 'openai', name: 'gpt-4o-mini', contextWindow: 128_000, maxOutputTokens: 16_384, inputPricePer1M: 0.15, outputPricePer1M: 0.6, capabilities: ['text', 'vision', 'json-mode'], tier: 'economy' },
  { key: 'ollama/llama3.1:8b', provider: 'ollama', name: 'llama3.1:8b', contextWindow: 128_000, maxOutputTokens: 8_192, inputPricePer1M: 0, outputPricePer1M: 0, capabilities: ['text', 'json-mode'], tier: 'local' },
];

export const POLICY: TenantAiPolicy = {
  defaultModel: 'anthropic/claude-sonnet-5-5',
  fallbackModels: ['openai/gpt-4o-mini', 'ollama/llama3.1:8b'],
  allowedModels: [],
  embeddingModel: 'openai/text-embedding-3-small',
  guardrails: { piiRedaction: true, promptInjection: 'block' },
};

type Behaviour = (req: ProviderRequest) => ProviderResponse | Error;

/** Scriptable provider: each call pops the next behaviour (the last one repeats). */
export class FakeProvider implements LlmProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly behaviours: Behaviour[],
  ) {}

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const out = this.next(req);
    if (out instanceof Error) throw out;
    return out;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    const out = this.next(req);
    if (out instanceof Error) throw out;
    for (const word of out.text.split(/(?<= )/)) yield { type: 'delta', text: word };
    yield { type: 'end', usage: out.usage, finishReason: out.finishReason };
  }

  private next(req: ProviderRequest): ProviderResponse | Error {
    this.calls.push(req);
    const b = this.behaviours[Math.min(this.calls.length - 1, this.behaviours.length - 1)]!;
    return b(req);
  }
}

export const ok =
  (text: string, inputTokens = 100, outputTokens = 50): Behaviour =>
  () => ({ text, usage: { inputTokens, outputTokens }, finishReason: 'stop' });

export const fail =
  (kind: ConstructorParameters<typeof ProviderError>[0], status?: number): Behaviour =>
  () => new ProviderError(kind, `fake ${kind}`, status);

export function makeGateway(
  providers: LlmProvider[],
  overrides: { policy?: Partial<TenantAiPolicy>; budgetMicroUsd?: number; opts?: Partial<AiGatewayOptions> } = {},
) {
  const recorder = new MemoryRecorder();
  const quota = new MemoryQuota(overrides.budgetMicroUsd);
  const cache = new MemoryExactCache();
  const gateway = new AiGateway(
    {
      providers,
      catalog: new StaticModelCatalog(MODELS),
      policies: new StaticPolicyProvider({ ...POLICY, ...overrides.policy }),
      quota,
      guardrails: new HeuristicGuardrails(),
      recorder,
      tracer: new NoopTracer(),
      logger: silentLogger,
      exactCache: cache,
    },
    { resilience: { maxRetries: 1, baseDelayMs: 1, errorThresholdPercentage: 50, volumeThreshold: 3, resetTimeoutMs: 60_000 }, ...overrides.opts },
  );
  return { gateway, recorder, quota, cache };
}

export const CTX = { tenantId: 't_1', userId: 'u_1', feature: 'REWRITE' as const };
