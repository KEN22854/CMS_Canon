import { AiGateway } from '@canon/ai-gateway';
import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { aiGatewayProvider } from './ai-gateway.provider';
import { AiUsageService } from './application/ai-usage.service';
import { AiBudgetAlerts } from './infrastructure/ai-budget-alerts';
import { AiUsageLedger } from './infrastructure/ai-usage-ledger';
import { DbModelCatalog } from './infrastructure/db-model-catalog';
import { PgSemanticCache } from './infrastructure/pg-semantic-cache';
import { PromptRegistry } from './infrastructure/prompt-registry';
import { PrismaUsageRecorder } from './infrastructure/prisma-usage-recorder';
import { RedisExactCache } from './infrastructure/redis-exact-cache';
import { RedisQuota } from './infrastructure/redis-quota';
import { TenantAiSettingsService } from './infrastructure/tenant-ai-settings';
import { AiController } from './presentation/ai.controller';

/**
 * Intelligence bounded context. Other modules depend on the exported AiGateway only — never on
 * provider SDKs — so swapping vendors or adding a self-hosted model is a config change.
 */
@Module({
  controllers: [AiController],
  providers: [
    DbModelCatalog,
    TenantAiSettingsService,
    AiUsageLedger,
    AiBudgetAlerts,
    AiUsageService,
    RedisQuota,
    RedisExactCache,
    PgSemanticCache,
    PrismaUsageRecorder,
    PromptRegistry,
    aiGatewayProvider,
  ],
  exports: [AiGateway, TenantAiSettingsService, PromptRegistry],
})
export class IntelligenceModule implements OnApplicationShutdown {
  constructor(private readonly gateway: AiGateway) {}

  async onApplicationShutdown(): Promise<void> {
    await this.gateway.shutdown();
  }
}
