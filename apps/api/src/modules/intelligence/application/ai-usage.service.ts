import { Injectable } from '@nestjs/common';
import { startOfMonthUtc } from '../../tenancy/tenants.service';
import { AiUsageLedger, forecastMonthEnd } from '../infrastructure/ai-usage-ledger';
import { BUDGET_THRESHOLDS } from '../infrastructure/ai-budget-alerts';
import { TenantAiSettingsService } from '../infrastructure/tenant-ai-settings';
import type { UsageQuery } from '../presentation/ai.dto';

/** AI usage dashboard payload: what was spent, on what, how it compares to the plan, where it is heading. */
@Injectable()
export class AiUsageService {
  constructor(
    private readonly ledger: AiUsageLedger,
    private readonly settings: TenantAiSettingsService,
  ) {}

  async report(tenantId: string, q: UsageQuery) {
    const now = new Date();
    const from = q.from ?? startOfMonthUtc(now);
    const to = q.to ?? now;
    const [report, month, { limits }] = await Promise.all([this.ledger.report(tenantId, from, to), this.ledger.monthToDate(tenantId), this.settings.settings(tenantId)]);

    const spentUsd = month.costMicroUsd / 1_000_000;
    const budgetUsd = limits.budgetMicroUsd === null ? null : limits.budgetMicroUsd / 1_000_000;
    const forecastUsd = forecastMonthEnd(spentUsd, now);
    return {
      ...report,
      month: {
        spentUsd,
        tokens: month.tokens,
        forecastUsd,
        budgetUsd,
        budgetUsedPct: budgetUsd ? Math.round((spentUsd / budgetUsd) * 1000) / 10 : null,
        forecastOverBudget: budgetUsd !== null && forecastUsd > budgetUsd,
        alertThresholdsPct: BUDGET_THRESHOLDS,
      },
      limits: {
        plan: limits.plan,
        tokensPerMonth: limits.tokensPerMonth,
        requestsPerMin: limits.requestsPerMin,
        requestsPerUserPerMin: limits.requestsPerUserPerMin,
        concurrentRequests: limits.concurrentRequests,
        modelTiers: limits.modelTiers,
        hardLimit: limits.hardLimit,
      },
    };
  }
}
