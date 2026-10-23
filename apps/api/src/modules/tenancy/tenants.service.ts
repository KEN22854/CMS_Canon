import { createId } from '@paralleldrive/cuid2';
import { Prisma, type MemberRole, type Tenant, type TenantPlan } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { RequestPrincipal } from '../../common/auth/principal';
import { conflict, forbidden, notFound, quotaExceeded } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { effectiveLimits, type PlanLimits } from './plans';
import { SLUG_RE, type CreateTenantBody, type UpdateTenantBody } from './tenancy.dto';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  plan: TenantPlan;
  role: MemberRole;
}

const SLUG_ATTEMPTS = 5;

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Tenant + OWNER membership in one transaction under the *new* tenant's RLS context — the
   * runtime role can create a tenant only by acting as that tenant, never by bypassing RLS.
   */
  async createForOwner(ownerId: string, body: Pick<CreateTenantBody, 'name' | 'slug' | 'template' | 'ai'>, plan: TenantPlan = 'FREE'): Promise<Tenant> {
    const base = body.slug ?? slugify(body.name);
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base.slice(0, 33)}-${createId().slice(0, 6)}`;
      // Slugs are globally unique, so availability is a cross-tenant read (system role). The
      // unique index still decides under races; the pre-check just keeps the common case clean.
      if (await this.system.tenant.findUnique({ where: { slug }, select: { id: true } })) {
        if (body.slug) throw conflict(`Slug "${body.slug}" is taken`);
        continue;
      }
      const id = createId();
      try {
        return await this.prisma.rawForTenant({ tenantId: id, userId: ownerId }, async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              id,
              name: body.name,
              slug,
              plan,
              settings: { onboarding: { template: body.template ?? 'blank', completedSteps: ['tenant'] } },
              aiSettings: (body.ai ?? {}) as Prisma.InputJsonValue,
            },
          });
          await tx.tenantMember.create({ data: { tenantId: id, userId: ownerId, role: 'OWNER', joinedAt: new Date() } });
          return tenant;
        });
      } catch (err) {
        const slugTaken = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!slugTaken) throw err;
        if (body.slug) throw conflict(`Slug "${body.slug}" is taken`);
      }
    }
    throw conflict('Could not allocate a unique slug, pick one explicitly');
  }

  async listForUser(userId: string): Promise<TenantSummary[]> {
    const rows = await this.prisma.forTenant({ userId }).tenantMember.findMany({
      where: { userId, tenant: { deletedAt: null } },
      include: { tenant: { select: { id: true, name: true, slug: true, plan: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({ ...m.tenant, role: m.role }));
  }

  /** Membership is re-read from the DB on every refresh/switch — tokens never outrank the DB. */
  async membership(userId: string, tenantId: string): Promise<{ role: MemberRole; tenant: Tenant } | null> {
    const m = await this.prisma.forTenant({ tenantId, userId }).tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { tenant: true },
    });
    return m && !m.tenant.deletedAt ? { role: m.role, tenant: m.tenant } : null;
  }

  async get(tenantId: string): Promise<Tenant> {
    const tenant = await this.prisma.forTenant({ tenantId }).tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) throw notFound('Tenant');
    return tenant;
  }

  async update(actor: RequestPrincipal, tenantId: string, body: UpdateTenantBody): Promise<Tenant> {
    const current = await this.get(tenantId);
    const data: Prisma.TenantUpdateInput = {};
    if (body.name) data.name = body.name;
    if (body.settings) data.settings = { ...(current.settings as object), ...body.settings } as Prisma.InputJsonValue;
    if (body.ai) data.aiSettings = { ...(current.aiSettings as object), ...body.ai } as Prisma.InputJsonValue;
    const updated = await this.prisma.forTenant({ tenantId, userId: actor.userId }).tenant.update({ where: { id: tenantId }, data });
    await this.audit.record({ tenantId, action: 'tenant.updated', entityType: 'Tenant', entityId: tenantId, changes: body as Prisma.InputJsonValue }, actor);
    return updated;
  }

  async softDelete(actor: RequestPrincipal, tenantId: string): Promise<void> {
    if (actor.memberRole !== 'OWNER' && actor.systemRole !== 'SUPER_ADMIN') throw forbidden('Only owners can delete a tenant');
    await this.prisma.forTenant({ tenantId, userId: actor.userId }).tenant.update({ where: { id: tenantId }, data: { deletedAt: new Date() } });
    await this.audit.record({ tenantId, action: 'tenant.deleted', entityType: 'Tenant', entityId: tenantId }, actor);
  }

  limits(tenant: Pick<Tenant, 'plan' | 'quota'>): PlanLimits {
    return effectiveLimits(tenant.plan, tenant.quota);
  }

  /** Current consumption vs. limits; one round-trip per counter, all index-backed. */
  async quotaUsage(tenantId: string) {
    const tenant = await this.get(tenantId);
    const limits = this.limits(tenant);
    const db = this.prisma.forTenant({ tenantId });
    const monthStart = startOfMonthUtc();
    const [members, pendingInvites, sites, pages, collections, entries, storage, ai] = await Promise.all([
      db.tenantMember.count({ where: { tenantId } }),
      db.invitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
      db.site.count({ where: { tenantId, deletedAt: null } }),
      db.page.count({ where: { tenantId, deletedAt: null } }),
      db.collection.count({ where: { tenantId, deletedAt: null } }),
      db.entry.count({ where: { tenantId, deletedAt: null } }),
      db.media.aggregate({ where: { tenantId, deletedAt: null }, _sum: { size: true } }),
      db.aiGeneration.aggregate({ where: { tenantId, createdAt: { gte: monthStart } }, _sum: { totalTokens: true, costUsd: true }, _count: true }),
    ]);
    const storageMb = Number(storage._sum.size ?? 0n) / 1_048_576;
    return {
      plan: tenant.plan,
      period: { from: monthStart.toISOString() },
      usage: {
        members,
        pendingInvites,
        sites,
        pages,
        collections,
        entries,
        storageMb: Math.round(storageMb * 10) / 10,
        aiTokens: ai._sum.totalTokens ?? 0,
        aiCostUsd: ai._sum.costUsd?.toNumber() ?? 0,
        aiRequests: ai._count,
      },
      limits,
    };
  }

  /** Plan gate for countable resources; `pending` lets invites reserve seats before acceptance. */
  async assertWithinLimit(tenantId: string, resource: 'members', pending = 0): Promise<void> {
    const tenant = await this.get(tenantId);
    const max = this.limits(tenant)[resource];
    if (max === null) return;
    const db = this.prisma.forTenant({ tenantId });
    const [members, invites] = await Promise.all([
      db.tenantMember.count({ where: { tenantId } }),
      db.invitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    if (members + invites + pending > max) {
      throw quotaExceeded(`Your ${tenant.plan} plan allows ${max} members`, { resource, limit: max });
    }
  }
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return SLUG_RE.test(s) ? s : `workspace-${createId().slice(0, 6)}`;
}

export function startOfMonthUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
