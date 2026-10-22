import { subject } from '@casl/ability';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { randomToken, sha256 } from '../../common/crypto/tokens';
import { conflict, forbidden, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Mailer } from '../../infrastructure/mail/mailer';
import { invitationMail } from '../../infrastructure/mail/templates';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import type { InviteBody } from './tenancy.dto';
import { TenantsService } from './tenants.service';

const INVITE_TTL_DAYS = 7;

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly tenants: TenantsService,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async invite(actor: TenantPrincipal, ability: AppAbility, body: InviteBody, req: Request) {
    const { tenantId } = actor;
    if (!actor.userId) throw forbidden('Invitations must be sent by a person, not an API key');
    if (!ability.can('invite', subject('Member', { tenantId, role: body.role }))) throw forbidden(`Not allowed to invite ${body.role}`);

    const inviter = await this.prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { name: true, emailVerified: true } });
    // Unverified accounts could otherwise use us as a spam relay.
    if (!inviter.emailVerified) throw forbidden('Verify your email before inviting others');

    const db = this.prisma.forTenant({ tenantId, userId: actor.userId });
    const existingMember = await db.tenantMember.findFirst({ where: { tenantId, user: { email: body.email } } });
    if (existingMember) throw conflict('This person is already a member');

    // Re-inviting replaces the pending invitation instead of reserving a second seat.
    await db.invitation.updateMany({ where: { tenantId, email: body.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.tenants.assertWithinLimit(tenantId, 'members', 1);

    const token = randomToken();
    const invitation = await db.invitation.create({
      data: {
        tenantId,
        email: body.email,
        role: body.role,
        tokenHash: sha256(token),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      },
    });
    const tenant = await this.tenants.get(tenantId);
    await this.mailer.send(invitationMail(body.email, tenant.name, inviter.name, body.role, `${this.config.ADMIN_PUBLIC_URL}/invite/${token}`));
    await this.audit.record({ tenantId, action: 'invitation.created', entityType: 'Invitation', entityId: invitation.id, changes: { email: body.email, role: body.role } }, actor, req);
    return present(invitation);
  }

  async listPending(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).invitation.findMany({
      where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(present);
  }

  async revoke(actor: TenantPrincipal, invitationId: string, req: Request): Promise<void> {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId });
    const res = await db.invitation.updateMany({ where: { id: invitationId, tenantId: actor.tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw notFound('Invitation');
    await this.audit.record({ tenantId: actor.tenantId, action: 'invitation.revoked', entityType: 'Invitation', entityId: invitationId }, actor, req);
  }

  /**
   * Public preview for the accept page. Token lookup uses the system role because the tenant is
   * unknown until the token is resolved; the response exposes only what the invite email already did.
   */
  async preview(token: string) {
    const inv = await this.byToken(token);
    return { email: inv.email, role: inv.role, tenant: { name: inv.tenant.name, slug: inv.tenant.slug }, invitedBy: inv.invitedBy.name, state: stateOf(inv), expiresAt: inv.expiresAt };
  }

  /** Called with an authenticated user, or by registration for a brand-new account. */
  async accept(token: string, user: { id: string; email: string }) {
    const inv = await this.byToken(token);
    const state = stateOf(inv);
    if (state !== 'pending') throw conflict(`Invitation is ${state}`);
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw forbidden('This invitation was sent to a different email address');
    }
    await this.prisma.rawForTenant({ tenantId: inv.tenantId, userId: user.id }, async (tx) => {
      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: inv.tenantId, userId: user.id } },
        create: { tenantId: inv.tenantId, userId: user.id, role: inv.role, invitedAt: inv.createdAt, joinedAt: new Date() },
        update: {},
      });
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedById: user.id } });
    });
    await this.audit.record({ tenantId: inv.tenantId, action: 'invitation.accepted', entityType: 'Invitation', entityId: inv.id }, { actorType: 'user', userId: user.id });
    return { tenantId: inv.tenantId, role: inv.role };
  }

  async acceptAs(token: string, userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, email: true } });
    return this.accept(token, user);
  }

  private async byToken(token: string) {
    const inv = await this.system.invitation.findUnique({
      where: { tokenHash: sha256(token) },
      include: { tenant: { select: { name: true, slug: true, deletedAt: true } }, invitedBy: { select: { name: true } } },
    });
    if (!inv || inv.tenant.deletedAt) throw notFound('Invitation');
    return inv;
  }
}

function stateOf(inv: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }): InvitationState {
  if (inv.acceptedAt) return 'accepted';
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt < new Date()) return 'expired';
  return 'pending';
}

function present(inv: { id: string; email: string; role: string; expiresAt: Date; createdAt: Date; invitedById: string }) {
  return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, createdAt: inv.createdAt, invitedById: inv.invitedById };
}
