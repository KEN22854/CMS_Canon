import { isModelKey, type ModelKey, type ModelTier, type TenantAiPolicy, type TenantPolicyProvider } from '@canon/ai-gateway';
import type { TenantPlan } from '@canon/db';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../../config/env';
import { SystemPrismaService } from '../../../infrastructure/prisma/prisma.service';
import { effectiveLimits } from '../../tenancy/plans';

const CACHE_TTL_MS = 30_000;

const modelKey = z.string().refine(isModelKey).transform((v) => v as ModelKey);

/** Tolerant parse: tenants created before a field existed fall back to plan/platform defaults. */
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

export interface TenantAiLimits {
  plan: TenantPlan;
  budgetMicroUsd: number | null;
  hardLimit: boolean;
  tokensPerMonth: number | null;
  requestsPerMin: number;
  requestsPerUserPerMin: number;
  concurrentRequests: number;
  modelTiers: ModelTier[];
}

export interface TenantAiSettings {
  name: string;
  policy: TenantAiPolicy;
  limits: TenantAiLimits;
}

/**
 * Merges three layers: plan defaults (plans.ts) → per-tenant quota overrides (Tenant.quota) →
 * tenant AI preferences (Tenant.aiSettings). A tenant may lower its budget but never escape its
 * plan's model tiers — that gate lives in `limits.modelTiers`, not in editable settings.
 * Read through the system role: quota enforcement must not depend on the caller's RLS context.
 */
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

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  async settings(tenantId: string): Promise<TenantAiSettings> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const tenant = await this.system.tenant.findUnique({ where: { id: tenantId }, select: { name: true, plan: true, aiSettings: true, quota: true } });
    if (!tenant) throw notFound('Tenant');

    const ai = aiSettingsSchema.safeParse(tenant.aiSettings);
    const s = ai.success ? ai.data : {};
    const plan = effectiveLimits(tenant.plan, tenant.quota);
    const planBudget = plan.aiBudgetUsd;
    // A tenant-set budget may only tighten the plan budget (except unlimited plans).
    const budgetUsd = s.budgetUsd === undefined ? planBudget : planBudget === null ? s.budgetUsd : Math.min(s.budgetUsd, planBudget);

    const value: TenantAiSettings = {
      name: tenant.name,
      policy: {
        defaultModel: s.defaultModel ?? this.config.AI_DEFAULT_MODEL,
        fallbackModels: s.fallbackModels ?? this.config.AI_FALLBACK_MODELS,
        allowedModels: s.allowedModels ?? [],
        allowedTiers: plan.aiModelTiers,
        embeddingModel: s.embeddingModel ?? this.config.AI_EMBEDDING_MODEL,
        guardrails: {
          piiRedaction: s.guardrailsPolicy?.piiRedaction ?? true,
          promptInjection: s.guardrailsPolicy?.promptInjection ?? 'block',
        },
      },
      limits: {
        plan: tenant.plan,
        budgetMicroUsd: budgetUsd === null ? null : Math.round(budgetUsd * 1_000_000),
        hardLimit: plan.aiHardLimit || (s.hardLimit ?? false),
        tokensPerMonth: plan.aiTokensPerMonth,
        requestsPerMin: plan.aiRequestsPerMin,
        requestsPerUserPerMin: plan.aiRequestsPerUserPerMin,
        concurrentRequests: plan.aiConcurrentRequests,
        modelTiers: plan.aiModelTiers,
      },
    };
    this.cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  }
}
