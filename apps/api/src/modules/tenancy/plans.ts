import type { ModelTier } from '@canon/ai-gateway';
import type { TenantPlan } from '@canon/db';
import { z } from 'zod';

/** `null` = unlimited. */
export interface PlanLimits {
  sites: number | null;
  pages: number | null;
  collections: number | null;
  /** Entries across all collections (soft-deleted excluded). */
  entries: number | null;
  storageMb: number | null;
  members: number | null;
  apiCallsPerMonth: number | null;
  aiTokensPerMonth: number | null;
  aiRequestsPerMin: number;
  aiRequestsPerUserPerMin: number;
  aiConcurrentRequests: number;
  maxAgents: number;
  aiModelTiers: ModelTier[];
  /** Default monthly AI budget; tenants may lower it (or raise it on ENTERPRISE). */
  aiBudgetUsd: number | null;
  /** FREE stops at the budget; paid plans keep working and alert (overage is billed). */
  aiHardLimit: boolean;
}

export const PLAN_LIMITS: Record<TenantPlan, PlanLimits> = {
  FREE: {
    sites: 1, pages: 50, collections: 5, entries: 1_000, storageMb: 500, members: 3, apiCallsPerMonth: 50_000,
    aiTokensPerMonth: 200_000, aiRequestsPerMin: 10, aiRequestsPerUserPerMin: 5, aiConcurrentRequests: 2, maxAgents: 0,
    aiModelTiers: ['economy', 'local'], aiBudgetUsd: 5, aiHardLimit: true,
  },
  PRO: {
    sites: 3, pages: 1_000, collections: 50, entries: 50_000, storageMb: 10_000, members: 10, apiCallsPerMonth: 1_000_000,
    aiTokensPerMonth: 5_000_000, aiRequestsPerMin: 60, aiRequestsPerUserPerMin: 20, aiConcurrentRequests: 5, maxAgents: 3,
    aiModelTiers: ['economy', 'standard', 'local'], aiBudgetUsd: 100, aiHardLimit: false,
  },
  BUSINESS: {
    sites: 10, pages: 10_000, collections: 200, entries: 500_000, storageMb: 100_000, members: 50, apiCallsPerMonth: 10_000_000,
    aiTokensPerMonth: 50_000_000, aiRequestsPerMin: 300, aiRequestsPerUserPerMin: 60, aiConcurrentRequests: 20, maxAgents: 20,
    aiModelTiers: ['economy', 'standard', 'premium', 'local'], aiBudgetUsd: 1_000, aiHardLimit: false,
  },
  ENTERPRISE: {
    sites: null, pages: null, collections: null, entries: null, storageMb: null, members: null, apiCallsPerMonth: null,
    aiTokensPerMonth: null, aiRequestsPerMin: 2_000, aiRequestsPerUserPerMin: 200, aiConcurrentRequests: 100, maxAgents: 200,
    aiModelTiers: ['economy', 'standard', 'premium', 'local'], aiBudgetUsd: null, aiHardLimit: false,
  },
};

const nullableCount = z.number().int().nonnegative().nullable();

/** Per-tenant overrides stored in Tenant.quota (negotiated enterprise limits, support grants). */
const overridesSchema = z
  .object({
    sites: nullableCount,
    pages: nullableCount,
    collections: nullableCount,
    entries: nullableCount,
    storageMb: nullableCount,
    members: nullableCount,
    apiCallsPerMonth: nullableCount,
    aiTokensPerMonth: nullableCount,
    aiRequestsPerMin: z.number().int().positive(),
    aiRequestsPerUserPerMin: z.number().int().positive(),
    aiConcurrentRequests: z.number().int().positive(),
    maxAgents: z.number().int().nonnegative(),
  })
  .partial();

export function effectiveLimits(plan: TenantPlan, overrides: unknown): PlanLimits {
  const parsed = overridesSchema.safeParse(overrides ?? {});
  return { ...PLAN_LIMITS[plan], ...(parsed.success ? parsed.data : {}) };
}
