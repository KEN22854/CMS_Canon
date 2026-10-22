import { randomUUID } from 'node:crypto';
import { AI_ERROR_CODES, AiGatewayError, ProviderError, isAbortError } from '../domain/errors';
import { parseModelKey } from '../domain/model-key';
import { costMicroUsd, estimateTokens } from '../domain/pricing';
import type {
  AiCallContext,
  AttemptRecord,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  FinishReason,
  GenerationStatus,
  ModelInfo,
  ProviderId,
  StreamEvent,
  TokenUsage,
} from '../domain/types';
import type {
  CachedCompletion,
  ExactCachePort,
  GatewayLogger,
  GenerationRecord,
  GuardrailFinding,
  GuardrailPort,
  InputInspection,
  LlmProvider,
  ModelCatalog,
  ProviderRequest,
  ProviderStreamChunk,
  QuotaPort,
  QuotaDenial,
  QuotaSlot,
  SemanticCachePort,
  TenantAiPolicy,
  TenantPolicyProvider,
  TracerPort,
  UsageRecorderPort,
} from '../ports';
import { exactCacheKey, semanticQueryText } from './cache-key';
import { DEFAULT_RESILIENCE, ProviderResilience, peekFirst, type ResilienceOptions } from './resilience';
import { buildCandidateChain } from './router';

export interface AiGatewayDeps {
  providers: LlmProvider[];
  catalog: ModelCatalog;
  policies: TenantPolicyProvider;
  quota: QuotaPort;
  guardrails: GuardrailPort;
  recorder: UsageRecorderPort;
  tracer: TracerPort;
  logger: GatewayLogger;
  exactCache?: ExactCachePort;
  semanticCache?: SemanticCachePort;
}

export interface AiGatewayOptions {
  defaultMaxTokens: number;
  requestTimeoutMs: number;
  streamTimeoutMs: number;
  exactCacheTtlSec: number;
  semanticCacheTtlSec: number;
  semanticHitThreshold: number;
  /** Looser threshold used only when every provider is down — a near answer beats no answer. */
  semanticDegradeThreshold: number;
  resilience: ResilienceOptions;
}

export const DEFAULT_GATEWAY_OPTIONS: AiGatewayOptions = {
  defaultMaxTokens: 4_096,
  requestTimeoutMs: 60_000,
  streamTimeoutMs: 300_000,
  exactCacheTtlSec: 86_400,
  semanticCacheTtlSec: 3_600,
  semanticHitThreshold: 0.95,
  semanticDegradeThreshold: 0.88,
  resilience: DEFAULT_RESILIENCE,
};

interface Prepared {
  generationId: string;
  startedAt: Date;
  policy: TenantAiPolicy;
  chain: ModelInfo[];
  system?: string;
  messages: ChatMessage[];
  inspection: InputInspection;
  promptText: string;
  cacheMode: 'none' | 'exact' | 'semantic';
  slot?: QuotaSlot;
}

export interface CallOptions {
  /** Client disconnect / caller cancellation; combined with the gateway timeout. */
  signal?: AbortSignal;
}

/**
 * Single entry point for every LLM call in the platform.
 * Pipeline: guardrails(in) → route → quota → cache → provider chain (retry + breaker + fallback)
 *           → guardrails(out) → cost → cache store → quota commit → record → trace.
 */
export class AiGateway {
  private readonly providers: Map<ProviderId, LlmProvider>;
  private readonly resilience: ProviderResilience;
  private readonly opts: AiGatewayOptions;

  constructor(
    private readonly deps: AiGatewayDeps,
    opts: Partial<AiGatewayOptions> = {},
  ) {
    this.opts = { ...DEFAULT_GATEWAY_OPTIONS, ...opts };
    this.providers = new Map(deps.providers.map((p) => [p.id, p]));
    this.resilience = new ProviderResilience(this.opts.resilience);
  }

  availableProviders(): ProviderId[] {
    return [...this.providers.keys()];
  }

  async complete(req: CompletionRequest, ctx: AiCallContext, call: CallOptions = {}): Promise<CompletionResult> {
    const p = await this.prepare(req, ctx);
    try {
      return await this.runComplete(p, req, ctx, call);
    } finally {
      await this.release(p);
    }
  }

  private async runComplete(p: Prepared, req: CompletionRequest, ctx: AiCallContext, call: CallOptions): Promise<CompletionResult> {

    const cached = await this.cacheLookup(p, req, ctx);
    if (cached) return this.finishFromCache(p, req, ctx, cached.value, cached.kind);

    const attempts: AttemptRecord[] = [];
    for (const model of p.chain) {
      const provider = this.providerFor(model);
      if (this.resilience.isOpen(model.provider)) {
        attempts.push({ model: model.key, error: 'circuit open', retryable: true });
        continue;
      }
      try {
        const resp = await this.resilience.execute(model.provider, () =>
          provider.complete(this.providerRequest(p, req, model, this.opts.requestTimeoutMs, call.signal)),
        );
        return await this.finishSuccess(p, req, ctx, model, resp.text, resp.usage, resp.finishReason, attempts);
      } catch (err) {
        if (call.signal?.aborted) throw err;
        attempts.push(this.attemptFrom(model, err));
        this.deps.logger.warn({ model: model.key, err: describe(err), tenantId: ctx.tenantId }, 'ai.provider_attempt_failed');
      }
    }
    return this.degrade(p, req, ctx, attempts);
  }

  async *stream(req: CompletionRequest, ctx: AiCallContext, call: CallOptions = {}): AsyncGenerator<StreamEvent> {
    const p = await this.prepare(req, ctx);
    // finally also runs when the consumer stops early (client disconnect → generator.return()).
    try {
      yield* this.runStream(p, req, ctx, call);
    } finally {
      await this.release(p);
    }
  }

  private async *runStream(p: Prepared, req: CompletionRequest, ctx: AiCallContext, call: CallOptions): AsyncGenerator<StreamEvent> {

    const cached = await this.cacheLookup(p, req, ctx);
    if (cached) {
      const result = await this.finishFromCache(p, req, ctx, cached.value, cached.kind);
      yield { type: 'start', generationId: p.generationId, model: result.model };
      yield { type: 'delta', text: result.text };
      yield { type: 'done', result };
      return;
    }

    const attempts: AttemptRecord[] = [];
    for (const model of p.chain) {
      const provider = this.providerFor(model);
      if (this.resilience.isOpen(model.provider)) {
        attempts.push({ model: model.key, error: 'circuit open', retryable: true });
        continue;
      }
      let opened: { first: IteratorResult<ProviderStreamChunk>; rest: AsyncIterator<ProviderStreamChunk> };
      try {
        opened = await this.resilience.execute(model.provider, () =>
          peekFirst(provider.stream(this.providerRequest(p, req, model, this.opts.streamTimeoutMs, call.signal))),
        );
      } catch (err) {
        if (call.signal?.aborted) throw err;
        attempts.push(this.attemptFrom(model, err));
        this.deps.logger.warn({ model: model.key, err: describe(err) }, 'ai.provider_stream_open_failed');
        continue;
      }

      // Past this point bytes reach the client: no more fallback, failures surface as errors.
      yield { type: 'start', generationId: p.generationId, model: model.key };
      let text = '';
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let finishReason: FinishReason = 'other';
      let next = opened.first;
      while (!next.done) {
        const chunk = next.value;
        if (chunk.type === 'delta') {
          text += chunk.text;
          yield { type: 'delta', text: chunk.text };
        } else {
          usage = chunk.usage;
          finishReason = chunk.finishReason;
        }
        next = await opened.rest.next();
      }
      // Output guardrails can only flag a stream after the fact; the record carries the finding.
      const result = await this.finishSuccess(p, req, ctx, model, text, usage, finishReason, attempts, { streamed: true });
      yield { type: 'done', result };
      return;
    }

    const result = await this.degrade(p, req, ctx, attempts);
    yield { type: 'start', generationId: p.generationId, model: result.model };
    if (result.text) yield { type: 'delta', text: result.text };
    yield { type: 'done', result };
  }

  async embed(req: EmbeddingRequest, ctx: AiCallContext, call: CallOptions = {}): Promise<EmbeddingResult> {
    if (req.input.length === 0) throw new AiGatewayError(AI_ERROR_CODES.INVALID_REQUEST, 'input must not be empty');
    const policy = await this.deps.policies.get(ctx.tenantId);
    const key = req.model ?? policy.embeddingModel;
    const model = this.deps.catalog.get(key);
    const provider = model ? this.providers.get(model.provider) : undefined;
    if (!model || !provider?.embed || !model.capabilities.includes('embedding')) {
      throw new AiGatewayError(AI_ERROR_CODES.NO_CANDIDATE_MODEL, `Embedding model ${key} is not available`);
    }
    const estimate = costMicroUsd(model, { inputTokens: estimateTokens(undefined, req.input.map((t) => ({ role: 'user', content: t }))), outputTokens: 0 });
    await this.assertQuota(ctx, estimate, estimateTokens(undefined, req.input.map((t) => ({ role: 'user', content: t }))));

    const startedAt = new Date();
    const embedFn = provider.embed.bind(provider);
    const { vectors, inputTokens } = await this.resilience.execute(model.provider, () =>
      embedFn({ model: model.name, input: req.input, signal: this.signal(this.opts.requestTimeoutMs, call.signal) }),
    );
    const usage = { inputTokens, outputTokens: 0 };
    const cost = costMicroUsd(model, usage);
    const generationId = randomUUID();
    await this.deps.quota.commit(ctx, generationId, cost, usage);
    await this.safeRecord({
      generationId,
      ctx: { ...ctx, feature: 'EMBEDDING' },
      model: model.key,
      modelId: model.id,
      promptText: `[${req.input.length} inputs]`,
      responseText: '',
      usage,
      costMicroUsd: cost,
      latencyMs: Date.now() - startedAt.getTime(),
      cacheHit: 'none',
      fallbackUsed: false,
      status: 'SUCCEEDED',
      guardrailFindings: [],
      attempts: [],
    }, startedAt);
    return { model: model.key, vectors, usage, costMicroUsd: cost };
  }

  async shutdown(): Promise<void> {
    this.resilience.shutdown();
    await this.deps.tracer.flush();
  }

  // ── pipeline steps ─────────────────────────────────────────────────────────

  private async prepare(req: CompletionRequest, ctx: AiCallContext): Promise<Prepared> {
    if (req.messages.length === 0) {
      throw new AiGatewayError(AI_ERROR_CODES.INVALID_REQUEST, 'messages must not be empty');
    }
    const startedAt = new Date();
    const generationId = randomUUID();
    const policy = await this.deps.policies.get(ctx.tenantId);

    const inspection = await this.deps.guardrails.inspectInput(req.system, req.messages, policy.guardrails);
    const promptText = serializePrompt(inspection.redactedSystem, inspection.redactedMessages);

    if (inspection.block) {
      await this.safeRecord(
        this.baseRecord(generationId, ctx, req.model ?? policy.defaultModel, promptText, 'BLOCKED', {
          guardrailFindings: inspection.findings,
          guardrailAction: 'BLOCKED',
          errorMessage: 'Blocked by input guardrails',
        }),
        startedAt,
      );
      throw new AiGatewayError(AI_ERROR_CODES.BLOCKED_BY_GUARDRAIL, 'Request blocked by guardrails', {
        findings: inspection.findings.map((f) => ({ type: f.type, severity: f.severity })),
      });
    }

    const chain = buildCandidateChain(req, policy, this.deps.catalog, new Set(this.providers.keys()));
    const first = chain[0]!;
    const maxTokens = Math.min(req.maxTokens ?? this.opts.defaultMaxTokens, first.maxOutputTokens);
    const inputEstimate = estimateTokens(req.system, req.messages);
    await this.assertQuota(ctx, costMicroUsd(first, { inputTokens: inputEstimate, outputTokens: maxTokens }), inputEstimate + maxTokens);
    const slot = await this.acquire(ctx);

    const redact = policy.guardrails.piiRedaction;
    return {
      generationId,
      startedAt,
      policy,
      chain,
      system: redact ? inspection.redactedSystem : req.system,
      messages: redact ? inspection.redactedMessages : req.messages,
      inspection,
      promptText,
      cacheMode: req.cache ?? 'exact',
      slot,
    };
  }

  private async assertQuota(ctx: AiCallContext, estimatedMicroUsd: number, estimatedTokens: number): Promise<void> {
    const decision = await this.deps.quota.check(ctx, estimatedMicroUsd, estimatedTokens);
    if (!decision.allowed) throw denialError(decision);
  }

  private async acquire(ctx: AiCallContext): Promise<QuotaSlot | undefined> {
    if (!this.deps.quota.acquire) return undefined;
    const slot = await this.deps.quota.acquire(ctx);
    if ('allowed' in slot) throw denialError(slot);
    return slot;
  }

  private async release(p: Prepared): Promise<void> {
    try {
      await p.slot?.release();
    } catch (err) {
      // A leaked slot self-heals via its TTL; never mask the call's own result with this.
      this.deps.logger.warn({ err: describe(err) }, 'ai.quota_slot_release_failed');
    }
  }

  private exactKey(p: Prepared, req: CompletionRequest): string {
    const model = p.chain[0]!;
    return exactCacheKey({
      model: model.key,
      system: p.system,
      messages: p.messages,
      maxTokens: req.maxTokens ?? this.opts.defaultMaxTokens,
      responseFormat: req.responseFormat ?? 'text',
      effort: req.effort,
    });
  }

  private async cacheLookup(
    p: Prepared,
    req: CompletionRequest,
    ctx: AiCallContext,
  ): Promise<{ value: CachedCompletion; kind: 'exact' | 'semantic' } | null> {
    if (p.cacheMode === 'none') return null;
    try {
      if (this.deps.exactCache) {
        const hit = await this.deps.exactCache.get(ctx.tenantId, this.exactKey(p, req));
        if (hit) return { value: hit, kind: 'exact' };
      }
      if (p.cacheMode === 'semantic' && this.deps.semanticCache) {
        const query = semanticQueryText(p.messages);
        const hit = query ? await this.deps.semanticCache.lookup(ctx.tenantId, query, ctx.feature, this.opts.semanticHitThreshold) : null;
        if (hit) return { value: hit, kind: 'semantic' };
      }
    } catch (err) {
      // Cache is an optimisation: an unavailable Redis must never fail an AI call.
      this.deps.logger.warn({ err: describe(err) }, 'ai.cache_lookup_failed');
    }
    return null;
  }

  private async finishFromCache(
    p: Prepared,
    req: CompletionRequest,
    ctx: AiCallContext,
    value: CachedCompletion,
    kind: 'exact' | 'semantic',
  ): Promise<CompletionResult> {
    const result: CompletionResult = {
      generationId: p.generationId,
      text: value.text,
      model: value.model,
      status: 'SUCCEEDED',
      usage: { inputTokens: 0, outputTokens: 0 },
      costMicroUsd: 0,
      latencyMs: Date.now() - p.startedAt.getTime(),
      cacheHit: kind,
      fallbackUsed: false,
      finishReason: value.finishReason,
      attempts: [],
    };
    await this.safeRecord(
      {
        ...this.baseRecord(p.generationId, ctx, value.model, p.promptText, 'SUCCEEDED', {
          guardrailFindings: p.inspection.findings,
          guardrailAction: guardrailAction(p.inspection.findings, p.policy.guardrails.piiRedaction),
        }),
        responseText: value.text,
        cacheHit: kind,
        latencyMs: result.latencyMs,
      },
      p.startedAt,
      p.system,
    );
    return result;
  }

  private async finishSuccess(
    p: Prepared,
    req: CompletionRequest,
    ctx: AiCallContext,
    model: ModelInfo,
    text: string,
    usage: TokenUsage,
    finishReason: FinishReason,
    attempts: AttemptRecord[],
    flags: { streamed?: boolean } = {},
  ): Promise<CompletionResult> {
    const cost = costMicroUsd(model, usage);
    const out = await this.deps.guardrails.inspectOutput(text, p.policy.guardrails);
    const findings: GuardrailFinding[] = [...p.inspection.findings, ...out.findings];
    // Refusals are terminal on purpose: re-routing a safety refusal to another provider would
    // turn the fallback chain into a way around model safety policies.
    const blocked = (out.block && !flags.streamed) || finishReason === 'refusal';
    const status: GenerationStatus = blocked ? 'BLOCKED' : 'SUCCEEDED';

    const result: CompletionResult = {
      generationId: p.generationId,
      text: blocked ? '' : text,
      model: model.key,
      status,
      usage,
      costMicroUsd: cost,
      latencyMs: Date.now() - p.startedAt.getTime(),
      cacheHit: 'none',
      fallbackUsed: model.key !== p.chain[0]!.key,
      finishReason,
      attempts,
    };

    await this.deps.quota.commit(ctx, p.generationId, cost, usage);
    if (!blocked && finishReason === 'stop' && p.cacheMode !== 'none') {
      await this.cacheStore(p, req, ctx, { text, model: model.key, usage, finishReason });
    }
    await this.safeRecord(
      {
        ...this.baseRecord(p.generationId, ctx, model.key, p.promptText, status, {
          guardrailFindings: findings,
          guardrailAction: blocked ? 'BLOCKED' : guardrailAction(findings, p.policy.guardrails.piiRedaction),
        }),
        modelId: model.id,
        responseText: text,
        usage,
        costMicroUsd: cost,
        latencyMs: result.latencyMs,
        fallbackUsed: result.fallbackUsed,
        finishReason,
        attempts: attempts.map(({ model: m, error }) => ({ model: m, error })),
      },
      p.startedAt,
      p.system,
    );
    return result;
  }

  private async cacheStore(p: Prepared, req: CompletionRequest, ctx: AiCallContext, value: CachedCompletion): Promise<void> {
    try {
      if (this.deps.exactCache) {
        await this.deps.exactCache.set(ctx.tenantId, this.exactKey(p, req), value, this.opts.exactCacheTtlSec);
      }
      if (p.cacheMode === 'semantic' && this.deps.semanticCache) {
        const query = semanticQueryText(p.messages);
        if (query) await this.deps.semanticCache.store(ctx.tenantId, query, ctx.feature, value, this.opts.semanticCacheTtlSec);
      }
    } catch (err) {
      this.deps.logger.warn({ err: describe(err) }, 'ai.cache_store_failed');
    }
  }

  /** Last two rungs of the fallback ladder: loose semantic cache, then caller-supplied degrade text. */
  private async degrade(p: Prepared, req: CompletionRequest, ctx: AiCallContext, attempts: AttemptRecord[]): Promise<CompletionResult> {
    if (this.deps.semanticCache) {
      try {
        const query = semanticQueryText(p.messages);
        const hit = query ? await this.deps.semanticCache.lookup(ctx.tenantId, query, ctx.feature, this.opts.semanticDegradeThreshold) : null;
        if (hit) {
          const result = await this.finishFromCache(p, req, ctx, hit, 'semantic');
          return { ...result, status: 'DEGRADED', fallbackUsed: true, attempts };
        }
      } catch (err) {
        this.deps.logger.warn({ err: describe(err) }, 'ai.degrade_semantic_lookup_failed');
      }
    }

    const status: GenerationStatus = req.degradeWith !== undefined ? 'DEGRADED' : 'FAILED';
    const errorMessage = `All ${p.chain.length} candidate models failed`;
    await this.safeRecord(
      {
        ...this.baseRecord(p.generationId, ctx, p.chain[0]!.key, p.promptText, status, {
          guardrailFindings: p.inspection.findings,
          guardrailAction: guardrailAction(p.inspection.findings, p.policy.guardrails.piiRedaction),
          errorMessage,
        }),
        responseText: req.degradeWith ?? '',
        fallbackUsed: true,
        attempts: attempts.map(({ model, error }) => ({ model, error })),
      },
      p.startedAt,
      p.system,
    );
    this.deps.logger.error({ tenantId: ctx.tenantId, feature: ctx.feature, attempts }, 'ai.all_providers_failed');

    if (req.degradeWith === undefined) {
      throw new AiGatewayError(AI_ERROR_CODES.ALL_PROVIDERS_FAILED, errorMessage, { attempts });
    }
    return {
      generationId: p.generationId,
      text: req.degradeWith,
      model: p.chain[0]!.key,
      status: 'DEGRADED',
      usage: { inputTokens: 0, outputTokens: 0 },
      costMicroUsd: 0,
      latencyMs: Date.now() - p.startedAt.getTime(),
      cacheHit: 'none',
      fallbackUsed: true,
      finishReason: 'other',
      attempts,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private providerFor(model: ModelInfo): LlmProvider {
    const provider = this.providers.get(model.provider);
    if (!provider) throw new Error(`Provider ${model.provider} not registered`); // router guarantees this
    return provider;
  }

  private providerRequest(p: Prepared, req: CompletionRequest, model: ModelInfo, timeoutMs: number, signal?: AbortSignal): ProviderRequest {
    return {
      model: parseModelKey(model.key).name,
      system: p.system,
      messages: p.messages,
      maxTokens: Math.min(req.maxTokens ?? this.opts.defaultMaxTokens, model.maxOutputTokens),
      responseFormat: req.responseFormat ?? 'text',
      effort: req.effort,
      signal: this.signal(req.timeoutMs ?? timeoutMs, signal),
    };
  }

  private signal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return caller ? AbortSignal.any([timeout, caller]) : timeout;
  }

  private attemptFrom(model: ModelInfo, err: unknown): AttemptRecord {
    if (err instanceof ProviderError) return { model: model.key, error: `${err.kind}: ${err.message}`, retryable: err.retryable };
    if (isAbortError(err)) return { model: model.key, error: 'timeout', retryable: true };
    return { model: model.key, error: describe(err), retryable: false };
  }

  private baseRecord(
    generationId: string,
    ctx: AiCallContext,
    model: GenerationRecord['model'],
    promptText: string,
    status: GenerationStatus,
    extra: Partial<GenerationRecord> & { guardrailFindings: GuardrailFinding[] },
  ): GenerationRecord {
    return {
      generationId,
      ctx,
      model,
      promptText,
      responseText: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      costMicroUsd: 0,
      latencyMs: 0,
      cacheHit: 'none',
      fallbackUsed: false,
      status,
      attempts: [],
      ...extra,
    };
  }

  private async safeRecord(rec: GenerationRecord, startedAt: Date, system?: string): Promise<void> {
    const endedAt = new Date();
    const full = { ...rec, latencyMs: rec.latencyMs || endedAt.getTime() - startedAt.getTime() };
    this.deps.tracer.generation({ ...full, startedAt, endedAt, system });
    try {
      await this.deps.recorder.record(full);
    } catch (err) {
      // Losing one usage row is recoverable from Langfuse; failing the user's request is not.
      this.deps.logger.error({ err: describe(err), generationId: rec.generationId }, 'ai.usage_record_failed');
    }
  }
}

/** PII findings mean the prompt was rewritten when redaction is on; anything else was only logged. */
function guardrailAction(findings: readonly GuardrailFinding[], piiRedaction: boolean): GenerationRecord['guardrailAction'] {
  if (findings.length === 0) return undefined;
  return piiRedaction && findings.some((f) => f.type === 'PII') ? 'MODIFIED' : 'LOGGED';
}

function serializePrompt(system: string | undefined, messages: readonly ChatMessage[]): string {
  const parts = system ? [`[system]\n${system}`] : [];
  for (const m of messages) {
    const body = typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mediaType}]`)).join('\n');
    parts.push(`[${m.role}]\n${body}`);
  }
  return parts.join('\n\n');
}

function denialError(d: QuotaDenial): AiGatewayError {
  const rateLike = d.reason === 'rate' || d.reason === 'concurrency';
  return new AiGatewayError(rateLike ? AI_ERROR_CODES.RATE_LIMITED : AI_ERROR_CODES.QUOTA_EXCEEDED, d.message, { reason: d.reason, retryAfterSec: d.retryAfterSec });
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
