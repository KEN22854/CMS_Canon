import { isModelKey, type ModelKey, type TenantAiPolicy, type TenantPolicyProvider } from '@canon/ai-gateway';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../../config/env';
import { API_ERROR_CODES, ApiError } from '../../../common/http/api-error';
import { SystemPrismaService } from '../../../infrastructure/prisma/prisma.service';

const CACHE_TTL_MS = 30_000;

const modelKey = z.string().refine(isModelKey).transform((v) => v as ModelKey);

/** Tolerant parse: tenants created before a field existed fall back to platform defaults. */
const aiSettingsSchema = z.object({
  defaultModel: modelKey.optional(),
  fallbackModels: z.array(modelKey).optional(),
  allowedModels: z.array(modelKey).optional(),
  embeddingModel: modelKey.optional(),
  budgetUsd: z.number().nonnegative().optional(),
  hardLimit: z.boolean().optional(),
  guardrailsPolicy: z
    .object({
      piiRedaction: z.boolean().optional(),
      promptInjection: z.enum(['block', 'log', 'off']).optional(),
    })
    .optional(),
});

const quotaSchema = z.object({
  aiRequestsPerMin: z.number().int().positive().optional(),
  aiTokensPerMonth: z.number().int().positive().optional(),
});

export interface TenantAiLimits {
  budgetMicroUsd: number | null;
  hardLimit: boolean;
  requestsPerMin: number;
}

export interface TenantAiSettings {
  policy: TenantAiPolicy;
  limits: TenantAiLimits;
}

const DEFAULT_REQUESTS_PER_MIN = 60;

@Injectable()
export class TenantAiSettingsService implements TenantPolicyProvider {
  private readonly cache = new Map<string, { value: TenantAiSettings; expiresAt: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly system: SystemPrismaService,
  ) {}

  async get(tenantId: string): Promise<TenantAiPolicy> {
    return (await this.settings(tenantId)).policy;
  }

  async settings(tenantId: string): Promise<TenantAiSettings> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const tenant = await this.system.tenant.findUnique({ where: { id: tenantId }, select: { aiSettings: true, quota: true } });
    if (!tenant) throw new ApiError(API_ERROR_CODES.NOT_FOUND, 'Tenant not found', HttpStatus.NOT_FOUND);

    const ai = aiSettingsSchema.safeParse(tenant.aiSettings);
    const quota = quotaSchema.safeParse(tenant.quota);
    const s = ai.success ? ai.data : {};
    const q = quota.success ? quota.data : {};

    const value: TenantAiSettings = {
      policy: {
        defaultModel: s.defaultModel ?? this.config.AI_DEFAULT_MODEL,
        fallbackModels: s.fallbackModels ?? this.config.AI_FALLBACK_MODELS,
        allowedModels: s.allowedModels ?? [],
        embeddingModel: s.embeddingModel ?? this.config.AI_EMBEDDING_MODEL,
        guardrails: {
          piiRedaction: s.guardrailsPolicy?.piiRedaction ?? true,
          promptInjection: s.guardrailsPolicy?.promptInjection ?? 'block',
        },
      },
      limits: {
        budgetMicroUsd: s.budgetUsd === undefined ? null : Math.round(s.budgetUsd * 1_000_000),
        hardLimit: s.hardLimit ?? false,
        requestsPerMin: q.aiRequestsPerMin ?? DEFAULT_REQUESTS_PER_MIN,
      },
    };
    this.cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
