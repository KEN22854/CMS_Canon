import { toModelKey, type ModelCapability, type ModelCatalog, type ModelInfo, type ModelKey, type ModelTier, type ProviderId } from '@canon/ai-gateway';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { SystemPrismaService } from '../../../infrastructure/prisma/prisma.service';

const REFRESH_MS = 60_000;

/**
 * Model registry backed by ai_models. Held in memory and refreshed periodically so routing is a
 * map lookup; price changes in the DB reach billing within a minute without a deploy.
 */
@Injectable()
export class DbModelCatalog implements ModelCatalog, OnModuleInit, OnModuleDestroy {
  private models = new Map<ModelKey, ModelInfo>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly system: SystemPrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DbModelCatalog.name);
  }

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err: unknown) => this.logger.warn({ err }, 'model catalog refresh failed; keeping previous snapshot'));
    }, REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(key: ModelKey): ModelInfo | undefined {
    return this.models.get(key);
  }

  list(): readonly ModelInfo[] {
    return [...this.models.values()];
  }

  async refresh(): Promise<void> {
    const rows = await this.system.aiModel.findMany({
      where: { isActive: true, provider: { isActive: true } },
      include: { provider: { select: { name: true } } },
    });
    const next = new Map<ModelKey, ModelInfo>();
    for (const r of rows) {
      const provider = r.provider.name as ProviderId;
      const key = toModelKey(provider, r.name);
      next.set(key, {
        key,
        id: r.id,
        provider,
        name: r.name,
        contextWindow: r.contextWindow,
        maxOutputTokens: r.maxOutputTokens,
        inputPricePer1M: r.inputPricePer1M.toNumber(),
        outputPricePer1M: r.outputPricePer1M.toNumber(),
        capabilities: r.capabilities as ModelCapability[],
        tier: r.tier as ModelTier,
        embeddingDims: r.embeddingDims ?? undefined,
      });
    }
    this.models = next;
    this.logger.debug({ count: next.size }, 'model catalog loaded');
  }
}
