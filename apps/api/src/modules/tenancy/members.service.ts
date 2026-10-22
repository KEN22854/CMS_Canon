import { subject } from '@casl/ability';
import type { MemberRole } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { SessionRevoker } from '../../common/auth/session-revoker';
import { conflict, forbidden, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revoker: SessionRevoker,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).tenantMember.findMany({
      where: { tenantId },
      include: { user: { select: { id: true, email: true, name: true, avatar: true, lastLoginAt: true, twoFactorEnabled: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({ ...m.user, role: m.role, joinedAt: m.joinedAt }));
  }

  async changeRole(actor: TenantPrincipal, ability: AppAbility, userId: string, role: MemberRole, req: Request) {
    const { tenantId } = actor;
    const target = await this.find(tenantId, userId);
    // Checked against the target's *current* role: an ADMIN cannot touch an OWNER row at all.
    if (!ability.can('update', subject('Member', { tenantId, role: target.role }))) throw forbidden('Not allowed to change this member');
    if (role === 'OWNER' && !isOwnerLike(actor)) throw forbidden('Only owners can grant ownership');
    if (target.role === role) return { userId, role };
    if (target.role === 'OWNER' && role !== 'OWNER') await this.assertNotLastOwner(tenantId);

    await this.prisma.forTenant({ tenantId, userId: actor.userId }).tenantMember.update({
      where: { tenantId_userId: { tenantId, userId } },
      data: { role },
    });
    // Outstanding access tokens carry the old role; force a refresh so the new one applies now.
    await this.revoker.forceRefresh(userId, tenantId);
    await this.audit.record({ tenantId, action: 'member.role_changed', entityType: 'Member', entityId: userId, changes: { from: target.role, to: role } }, actor, req);
    return { userId, role };
  }

  async remove(actor: TenantPrincipal, ability: AppAbility, userId: string, req: Request): Promise<void> {
    const { tenantId } = actor;
    const target = await this.find(tenantId, userId);
    const leavingSelf = actor.userId === userId;
    if (!leavingSelf && !ability.can('delete', subject('Member', { tenantId, role: target.role }))) {
      throw forbidden('Not allowed to remove this member');
    }
    if (target.role === 'OWNER') await this.assertNotLastOwner(tenantId);

    await this.prisma.forTenant({ tenantId, userId: actor.userId }).tenantMember.delete({ where: { tenantId_userId: { tenantId, userId } } });
    await this.revoker.forceRefresh(userId, tenantId);
    await this.audit.record({ tenantId, action: leavingSelf ? 'member.left' : 'member.removed', entityType: 'Member', entityId: userId, changes: { role: target.role } }, actor, req);
  }

  private async find(tenantId: string, userId: string) {
    const m = await this.prisma.forTenant({ tenantId }).tenantMember.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    if (!m) throw notFound('Member');
    return m;
  }

  /** A tenant without an owner cannot be billed, deleted or recovered — never allow it. */
  private async assertNotLastOwner(tenantId: string): Promise<void> {
    const owners = await this.prisma.forTenant({ tenantId }).tenantMember.count({ where: { tenantId, role: 'OWNER' } });
    if (owners <= 1) throw conflict('A tenant must keep at least one owner — transfer ownership first');
  }
}

function isOwnerLike(p: TenantPrincipal): boolean {
  return p.memberRole === 'OWNER' || p.systemRole === 'SUPER_ADMIN';
}
