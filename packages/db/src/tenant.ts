import { Prisma, type PrismaClient } from '@prisma/client';

export interface RlsContext {
  tenantId?: string;
  userId?: string;
}

/**
 * Binds every query to a tenant/user at the database level (layer 2 of the double tenant guard;
 * layer 1 is the application-side tenantId filter in repositories).
 *
 * Each operation runs inside a transaction that first sets the RLS GUCs with `is_local = true`,
 * so the settings die with the transaction and can never leak to another request through the
 * connection pool. Policies read them via current_setting(..., true); when missing they match
 * nothing — the failure mode is "no rows", never "all rows".
 */
export function withTenant(prisma: PrismaClient, ctx: RlsContext) {
  if (!ctx.tenantId && !ctx.userId) {
    throw new Error('withTenant: tenantId or userId is required');
  }
  const tenantId = ctx.tenantId ?? '';
  const userId = ctx.userId ?? '';
  return prisma.$extends(
    Prisma.defineExtension((client) =>
      client.$extends({
        name: 'tenant-rls',
        query: {
          $allModels: {
            async $allOperations({ args, query }) {
              const [, result] = await client.$transaction([
                client.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`,
                query(args),
              ]);
              return result;
            },
          },
        },
      }),
    ),
  );
}

export type TenantScopedClient = ReturnType<typeof withTenant>;
