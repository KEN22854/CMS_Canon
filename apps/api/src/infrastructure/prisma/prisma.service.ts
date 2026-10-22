import { PrismaClient, withTenant, type Prisma, type RlsContext, type TenantScopedClient } from '@canon/db';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';

const SCOPED_CACHE_MAX = 500;

/**
 * Runtime client on the `canon_app` role: every tenant table is behind RLS. Request code gets a
 * tenant-bound client via `forTenant()` — a plain query without one returns no tenant rows.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly scoped = new Map<string, TenantScopedClient>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ datasources: { db: { url: config.APP_DATABASE_URL } }, log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Extension clients are cheap but not free; a small LRU avoids rebuilding one per request. */
  forTenant(ctx: RlsContext): TenantScopedClient {
    const key = `${ctx.tenantId ?? ''}|${ctx.userId ?? ''}`;
    let client = this.scoped.get(key);
    if (client) {
      this.scoped.delete(key);
    } else {
      client = withTenant(this, ctx);
    }
    this.scoped.set(key, client);
    if (this.scoped.size > SCOPED_CACHE_MAX) {
      const oldest = this.scoped.keys().next().value;
      if (oldest !== undefined) this.scoped.delete(oldest);
    }
    return client;
  }

  /**
   * Raw SQL (pgvector, CTEs) bypasses model-level extensions, so it gets its own transaction
   * with the same RLS GUCs. Use for every $queryRaw touching tenant tables.
   */
  async rawForTenant<T>(ctx: RlsContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
      return fn(tx);
    });
  }
}

/**
 * `canon_system` role (BYPASSRLS). Only for cross-tenant infrastructure: tenant resolution,
 * model registry, schedulers, outbox relay. Never inject into request handlers that touch content.
 */
@Injectable()
export class SystemPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ datasources: { db: { url: config.SYSTEM_DATABASE_URL } }, log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
