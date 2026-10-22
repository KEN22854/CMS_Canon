import { isModelKey, type ModelKey } from '@canon/ai-gateway';
import { z } from 'zod';

const modelKey = z.string().refine(isModelKey, { message: 'expected "<provider>/<model>"' }).transform((v) => v as ModelKey);
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(item));
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/**
 * Single source of truth for configuration. Parsed once at boot; the process refuses to start on
 * invalid config rather than failing on the first request that touches the bad value.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: csv(z.url()),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  APP_DATABASE_URL: z.string().startsWith('postgresql://'),
  SYSTEM_DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().startsWith('redis'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  ANTHROPIC_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  GOOGLE_API_KEY: optionalSecret,
  OLLAMA_BASE_URL: z.url().optional().or(z.literal('').transform(() => undefined)),

  AI_DEFAULT_MODEL: modelKey.default('anthropic/claude-sonnet-5-5'),
  AI_FALLBACK_MODELS: csv(modelKey),
  AI_EMBEDDING_MODEL: modelKey.default('openai/text-embedding-3-small'),
  AI_EXACT_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(86_400),
  AI_SEMANTIC_CACHE_ENABLED: z.stringbool().default(true),
  AI_SEMANTIC_CACHE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.95),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  LANGFUSE_BASE_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  LANGFUSE_PUBLIC_KEY: optionalSecret,
  LANGFUSE_SECRET_KEY: optionalSecret,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional().or(z.literal('').transform(() => undefined)),
  OTEL_SERVICE_NAME: z.string().default('canon-api'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_ACCESS_SECRET.startsWith('dev-')) {
    throw new Error('Refusing to start in production with development JWT secrets');
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
