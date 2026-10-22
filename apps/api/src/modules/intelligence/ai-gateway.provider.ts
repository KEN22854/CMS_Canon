import {
  AiGateway,
  AnthropicProvider,
  GoogleProvider,
  HeuristicGuardrails,
  LangfuseHttpTracer,
  NoopTracer,
  OllamaProvider,
  OpenAiProvider,
  type GatewayLogger,
  type LlmProvider,
} from '@canon/ai-gateway';
import type { Provider } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { DbModelCatalog } from './infrastructure/db-model-catalog';
import { PgSemanticCache } from './infrastructure/pg-semantic-cache';
import { PrismaUsageRecorder } from './infrastructure/prisma-usage-recorder';
import { RedisExactCache } from './infrastructure/redis-exact-cache';
import { RedisQuota } from './infrastructure/redis-quota';
import { TenantAiSettingsService } from './infrastructure/tenant-ai-settings';

export function buildProviders(config: AppConfig): LlmProvider[] {
  const providers: LlmProvider[] = [];
  if (config.ANTHROPIC_API_KEY) providers.push(new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY }));
  if (config.OPENAI_API_KEY) providers.push(new OpenAiProvider({ apiKey: config.OPENAI_API_KEY }));
  if (config.GOOGLE_API_KEY) providers.push(new GoogleProvider({ apiKey: config.GOOGLE_API_KEY }));
  if (config.OLLAMA_BASE_URL) providers.push(new OllamaProvider({ baseUrl: config.OLLAMA_BASE_URL }));
  return providers;
}

function gatewayLogger(logger: PinoLogger): GatewayLogger {
  return {
    debug: (obj, msg) => logger.debug(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
}

/** Composition root of the Intelligence context: the only place that knows concrete adapters. */
export const aiGatewayProvider: Provider = {
  provide: AiGateway,
  inject: [APP_CONFIG, PinoLogger, DbModelCatalog, TenantAiSettingsService, RedisQuota, RedisExactCache, PgSemanticCache, PrismaUsageRecorder],
  useFactory: (
    config: AppConfig,
    pino: PinoLogger,
    catalog: DbModelCatalog,
    policies: TenantAiSettingsService,
    quota: RedisQuota,
    exactCache: RedisExactCache,
    semanticCache: PgSemanticCache,
    recorder: PrismaUsageRecorder,
  ): AiGateway => {
    pino.setContext('AiGateway');
    const logger = gatewayLogger(pino);
    const tracer =
      config.LANGFUSE_BASE_URL && config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY
        ? new LangfuseHttpTracer({ baseUrl: config.LANGFUSE_BASE_URL, publicKey: config.LANGFUSE_PUBLIC_KEY, secretKey: config.LANGFUSE_SECRET_KEY }, logger)
        : new NoopTracer();

    const providers = buildProviders(config);
    if (providers.length === 0) {
      pino.warn('No AI provider configured (set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OLLAMA_BASE_URL); AI calls will degrade');
    }

    const gateway = new AiGateway(
      {
        providers,
        catalog,
        policies,
        quota,
        guardrails: new HeuristicGuardrails(),
        recorder,
        tracer,
        logger,
        exactCache,
        semanticCache: config.AI_SEMANTIC_CACHE_ENABLED ? semanticCache : undefined,
      },
      {
        requestTimeoutMs: config.AI_REQUEST_TIMEOUT_MS,
        exactCacheTtlSec: config.AI_EXACT_CACHE_TTL_SEC,
        semanticHitThreshold: config.AI_SEMANTIC_CACHE_THRESHOLD,
      },
    );

    semanticCache.bindEmbedder(async (tenantId, text) => {
      const res = await gateway.embed({ input: [text] }, { tenantId, feature: 'EMBEDDING' });
      return res.vectors[0] ?? [];
    });
    return gateway;
  },
};
