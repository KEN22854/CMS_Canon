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
  /**
   * Express 'trust proxy'. Subnets, not a hop count: browser → ingress → Next (admin) → API and
   * SDK → ingress → API have different depths, and only trusting internal networks yields the real
   * client IP for both (rate limits and lockouts key on it).
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  APP_DATABASE_URL: z.string().startsWith('postgresql://'),
  SYSTEM_DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().startsWith('redis'),

  ADMIN_PUBLIC_URL: z.url().default('http://localhost:3000'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** 32 random bytes, base64 — field-level encryption (TOTP seeds, webhook secrets). */
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, { message: 'must be 32 bytes, base64' }),
  /** Set when admin and API live on different subdomains of one site (e.g. ".canon.app"). */
  AUTH_COOKIE_DOMAIN: z.string().optional().or(z.literal('').transform(() => undefined)),

  /** Sites get <site>-<tenant>.<domain>; *.localhost resolves to 127.0.0.1 in browsers, so dev needs no hosts file. */
  PUBLIC_SITES_DOMAIN: z.string().default('canon.localhost'),
  /** Public renderer (apps/web): preview links and on-demand ISR revalidation. */
  WEB_PUBLIC_PORT: z.coerce.number().int().positive().default(3001),
  WEB_REVALIDATE_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  REVALIDATE_SECRET: z.string().min(16).default('dev-revalidate-secret-change-me'),
  /** Shared secret the renderer presents to the delivery API (published content is public, but the API is not a CDN). */
  DELIVERY_TOKEN: z.string().min(16).default('dev-delivery-token-change-me'),
  PREVIEW_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(1_800),

  S3_ENDPOINT: z.url().optional().or(z.literal('').transform(() => undefined)),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('canon-media'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  /** Base URL objects are served from (CDN in prod; MinIO bucket URL in dev). */
  S3_PUBLIC_URL: z.url().optional().or(z.literal('').transform(() => undefined)),
  MEDIA_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(5_000).default(25),

  SMTP_URL: z.string().startsWith('smtp').default('smtp://localhost:1035'),
  MAIL_FROM: z.string().default('Canon <no-reply@canon.local>'),
  /** "smtp" in dev/prod (Mailpit locally); "memory" keeps mails in-process for tests. */
  MAIL_TRANSPORT: z.enum(['smtp', 'memory']).default('smtp'),

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

  /** Billing is off until a Stripe secret key is configured; plans can still be set by super admins. */
  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  /** Overridable for tests (a local fake) and Stripe's mock server. */
  STRIPE_API_BASE: z.url().default('https://api.stripe.com'),
  STRIPE_PRICE_PRO: z.string().optional().or(z.literal('').transform(() => undefined)),
  STRIPE_PRICE_BUSINESS: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Billing meter event name for AI overage (cents above the plan's included budget). */
  STRIPE_AI_METER_EVENT: z.string().default('canon_ai_overage_cents'),

  /** SSO domains are proven with a DNS TXT record; 'off' (dev/test only) trusts the claim. */
  SSO_DOMAIN_VERIFICATION: z.enum(['dns', 'off']).default('dns'),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.JWT_ACCESS_SECRET.startsWith('dev-')) throw new Error('Refusing to start in production with development JWT secrets');
    if (parsed.data.MAIL_TRANSPORT === 'memory') throw new Error('MAIL_TRANSPORT=memory is test-only');
    if (parsed.data.SSO_DOMAIN_VERIFICATION === 'off') throw new Error('SSO_DOMAIN_VERIFICATION=off is for development only');
    for (const k of ['REVALIDATE_SECRET', 'DELIVERY_TOKEN'] as const) if (parsed.data[k].startsWith('dev-')) throw new Error(`Refusing to start in production with the development ${k}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
