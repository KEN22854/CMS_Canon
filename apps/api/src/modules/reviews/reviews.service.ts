import type { ContentEntityType, ReviewStatus } from '@canon/db';
import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, forbidden, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const reviewable = z.enum(['PAGE', 'ENTRY']);

export const requestReviewBody = z
  .object({
    entityType: reviewable,
    entityId: z.string().min(1).max(40),
    reviewerIds: z.array(z.string().max(40)).max(10).default([]),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export const decideBody = z
  .object({ note: z.string().trim().max(1000).optional() })
  .strict()
  .default({});
export const reviewsQuery = z.object({
  status: z.enum(['OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'CANCELLED']).optional(),
  entityId: z.string().max(40).optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export const commentsQuery = z.object({ entityType: reviewable, entityId: z.string().min(1).max(40) });
export const createCommentBody = z
  .object({
    entityType: reviewable,
    entityId: z.string().min(1).max(40),
    blockId: z.string().max(64).optional(),
    parentId: z.string().max(40).optional(),
    body: z.string().trim().min(1).max(5000),
    mentions: z.array(z.string().max(40)).max(20).default([]),
  })
  .strict();
export const updateCommentBody = z
  .object({ body: z.string().trim().min(1).max(5000).optional(), resolved: z.boolean().optional() })
  .strict();

interface Entity {
  type: ContentEntityType;
  id: string;
  siteId: string;
  title: string;
  version: number;
  link: string;
}

/**
 * Review workflow: an author asks for review of a specific draft version; a publisher approves or
 * sends it back. On sites with `requireReview`, publishing needs an approval of exactly the version
 * being published — any edit after approval makes it stale. Owners and admins can override, and
 * the override is audited.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async entity(tenantId: string, type: string, id: string, siteId?: string): Promise<Entity> {
    if (type === 'PAGE') {
      const p = await this.system.page.findFirst({
        where: { id, tenantId, deletedAt: null, ...(siteId ? { siteId } : {}) },
        select: { id: true, siteId: true, title: true, version: true },
      });
      if (!p) throw notFound('Page');
      return {
        type: 'PAGE',
        id: p.id,
        siteId: p.siteId,
        title: p.title || 'Untitled page',
        version: p.version,
        link: `/sites/${p.siteId}/pages/${p.id}`,
      };
    }
    if (type === 'ENTRY') {
      const e = await this.system.entry.findFirst({
        where: { id, tenantId, deletedAt: null, ...(siteId ? { collection: { siteId } } : {}) },
        select: {
          id: true,
          title: true,
          version: true,
          collectionId: true,
          collection: { select: { siteId: true } },
        },
      });
      if (!e) throw notFound('Entry');
      return {
        type: 'ENTRY',
        id: e.id,
        siteId: e.collection.siteId,
        title: e.title || 'Untitled entry',
        version: e.version,
        link: `/sites/${e.collection.siteId}/collections/${e.collectionId}/entries/${e.id}`,
      };
    }
    throw badRequest('INVALID_ENTITY', 'Only pages and entries can be reviewed');
  }

  // ── reviews ────────────────────────────────────────────────────────────────

  async request(actor: TenantPrincipal, siteId: string, body: z.infer<typeof requestReviewBody>) {
    const e = await this.entity(actor.tenantId, body.entityType, body.entityId, siteId);
    const reviewers = await this.publishers(
      actor.tenantId,
      body.reviewerIds.length ? body.reviewerIds : undefined,
    );
    if (body.reviewerIds.length && reviewers.length !== new Set(body.reviewerIds).size)
      throw badRequest('INVALID_REVIEWER', 'Reviewers must be members who can publish');
    const others = reviewers.filter((r) => r !== actor.userId);
    // One open request per item: asking again replaces the previous one.
    await this.system.reviewRequest.updateMany({
      where: { tenantId: actor.tenantId, entityType: e.type, entityId: e.id, status: 'OPEN' },
      data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: actor.userId ?? null },
    });
    const row = await this.system.reviewRequest.create({
      data: {
        tenantId: actor.tenantId,
        siteId: e.siteId,
        entityType: e.type,
        entityId: e.id,
        version: e.version,
        note: body.note ?? null,
        requestedById: actor.userId ?? null,
        reviewerIds: body.reviewerIds,
      },
    });
    const requester = await this.userName(actor.userId);
    await this.notifications.notify(actor.tenantId, others, {
      type: 'review.requested',
      title: `${requester} asks you to review “${e.title}”`,
      message: body.note ?? 'Open it to approve or request changes.',
      link: `${e.link}?review=${row.id}`,
      data: { reviewId: row.id },
    });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'review.requested',
        entityType: e.type === 'PAGE' ? 'Page' : 'Entry',
        entityId: e.id,
        changes: { version: e.version, reviewers: body.reviewerIds },
      },
      actor,
    );
    return (await this.withNames(actor.tenantId, [this.present(row, e)]))[0]!;
  }

  async decide(
    actor: TenantPrincipal,
    ability: AppAbility | null,
    reviewId: string,
    decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'CANCELLED',
    note?: string,
  ) {
    const r = await this.system.reviewRequest.findFirst({
      where: { id: reviewId, tenantId: actor.tenantId },
    });
    if (!r) throw notFound('Review');
    if (r.status !== 'OPEN')
      throw new ApiError(
        'REVIEW_CLOSED',
        `This review is already ${r.status.toLowerCase().replace('_', ' ')}`,
        HttpStatus.CONFLICT,
      );
    const e = await this.entity(actor.tenantId, r.entityType, r.entityId);
    if (decision === 'CANCELLED') {
      if (r.requestedById !== actor.userId && !ability?.can('manage', 'all'))
        throw forbidden('Only the requester can cancel a review');
    } else {
      if (ability && !ability.can('publish', e.type === 'PAGE' ? 'Page' : 'Entry'))
        throw forbidden('Only members who can publish can review');
      // Four-eyes: approving your own request would make the gate meaningless.
      if (r.requestedById && r.requestedById === actor.userId)
        throw forbidden('You cannot review your own request');
      if (decision === 'CHANGES_REQUESTED' && !note)
        throw badRequest('NOTE_REQUIRED', 'Say what needs to change');
    }
    const row = await this.system.reviewRequest.update({
      where: { id: r.id },
      data: {
        status: decision,
        decidedById: actor.userId ?? null,
        decidedAt: new Date(),
        decisionNote: note ?? null,
      },
    });
    if (decision !== 'CANCELLED' && r.requestedById) {
      const who = await this.userName(actor.userId);
      const title =
        decision === 'APPROVED' ? `${who} approved “${e.title}”` : `${who} asked for changes on “${e.title}”`;
      await this.notifications.notify(actor.tenantId, [r.requestedById], {
        type: 'review.decided',
        title,
        message: note ?? '',
        link: `${e.link}?review=${r.id}`,
        data: { reviewId: r.id, decision },
      });
    }
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: `review.${decision.toLowerCase()}`,
        entityType: e.type === 'PAGE' ? 'Page' : 'Entry',
        entityId: e.id,
        changes: { reviewId: r.id, version: r.version },
      },
      actor,
    );
    return (await this.withNames(actor.tenantId, [this.present(row, e)]))[0]!;
  }

  async list(tenantId: string, siteId: string, q: z.infer<typeof reviewsQuery>, userId?: string) {
    const rows = await this.system.reviewRequest.findMany({
      where: {
        tenantId,
        siteId,
        ...(q.status ? { status: q.status as ReviewStatus } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.mine === 'true' && userId
          ? {
              OR: [{ reviewerIds: { has: userId } }, { reviewerIds: { isEmpty: true } }],
              NOT: { requestedById: userId },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const out = [];
    for (const r of rows) {
      const e = await this.entity(tenantId, r.entityType, r.entityId).catch(() => null);
      if (e) out.push(this.present(r, e));
    }
    return this.withNames(tenantId, out);
  }

  /**
   * The publish gate. Returns silently when publishing may go ahead; throws REVIEW_REQUIRED
   * otherwise. `override` lets owners/admins publish anyway (recorded in the audit log).
   */
  async assertPublishable(
    actor: TenantPrincipal,
    ability: AppAbility | null,
    siteId: string,
    type: 'PAGE' | 'ENTRY',
    id: string,
    override = false,
  ): Promise<void> {
    const site = await this.system.site.findFirst({
      where: { id: siteId, tenantId: actor.tenantId, deletedAt: null },
      select: { requireReview: true },
    });
    if (!site?.requireReview) return;
    const e = await this.entity(actor.tenantId, type, id, siteId);
    const approved = await this.system.reviewRequest.findFirst({
      where: {
        tenantId: actor.tenantId,
        entityType: type,
        entityId: id,
        status: 'APPROVED',
        version: e.version,
      },
      select: { id: true },
    });
    if (approved) return;
    if (override && ability?.can('manage', 'all') && actor.actorType === 'user') {
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          action: 'review.overridden',
          entityType: type === 'PAGE' ? 'Page' : 'Entry',
          entityId: id,
          changes: { version: e.version },
        },
        actor,
      );
      return;
    }
    const stale = await this.system.reviewRequest.findFirst({
      where: { tenantId: actor.tenantId, entityType: type, entityId: id, status: 'APPROVED' },
      select: { version: true },
    });
    throw new ApiError(
      'REVIEW_REQUIRED',
      stale
        ? `The approval was for version ${stale.version}; the draft changed since (now ${e.version}). Ask for review again.`
        : 'This site requires an approved review before publishing',
      HttpStatus.CONFLICT,
      { version: e.version, canOverride: Boolean(ability?.can('manage', 'all')) },
    );
  }

  /**
   * For scheduled publishes (checked when scheduling): true when the draft was edited after its
   * approval, so the scheduled run must not ship unreviewed changes.
   */
  async approvalWentStale(
    tenantId: string,
    siteId: string,
    type: 'PAGE' | 'ENTRY',
    id: string,
  ): Promise<boolean> {
    const site = await this.system.site.findFirst({
      where: { id: siteId, tenantId },
      select: { requireReview: true },
    });
    if (!site?.requireReview) return false;
    const e = await this.entity(tenantId, type, id, siteId);
    const last = await this.system.reviewRequest.findFirst({
      where: { tenantId, entityType: type, entityId: id, status: 'APPROVED' },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return Boolean(last && last.version !== e.version);
  }

  // ── comments ───────────────────────────────────────────────────────────────

  async comments(tenantId: string, q: z.infer<typeof commentsQuery>) {
    await this.entity(tenantId, q.entityType, q.entityId);
    const rows = await this.system.comment.findMany({
      where: { tenantId, entityType: q.entityType, entityId: q.entityId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return this.withNames(
      tenantId,
      rows.map((c) => ({ ...c, authorName: null as string | null })),
    );
  }

  async comment(actor: TenantPrincipal, body: z.infer<typeof createCommentBody>) {
    const e = await this.entity(actor.tenantId, body.entityType, body.entityId);
    let parent: { id: string; authorId: string | null; blockId: string | null } | null = null;
    if (body.parentId) {
      parent = await this.system.comment.findFirst({
        where: {
          id: body.parentId,
          tenantId: actor.tenantId,
          entityId: e.id,
          parentId: null,
          deletedAt: null,
        },
        select: { id: true, authorId: true, blockId: true },
      });
      if (!parent) throw notFound('Comment');
    }
    const members = await this.system.tenantMember.findMany({
      where: { tenantId: actor.tenantId, userId: { in: body.mentions } },
      select: { userId: true },
    });
    const mentions = members.map((m) => m.userId).filter((u) => u !== actor.userId);
    const row = await this.system.comment.create({
      data: {
        tenantId: actor.tenantId,
        entityType: e.type,
        entityId: e.id,
        blockId: parent ? parent.blockId : (body.blockId ?? null),
        parentId: parent?.id ?? null,
        authorId: actor.userId ?? null,
        body: body.body,
        mentions,
      },
    });
    const who = await this.userName(actor.userId);
    const link = `${e.link}?comment=${parent?.id ?? row.id}`;
    const excerpt = body.body.length > 140 ? `${body.body.slice(0, 137)}…` : body.body;
    await this.notifications.notify(actor.tenantId, mentions, {
      type: 'comment.mentioned',
      title: `${who} mentioned you on “${e.title}”`,
      message: excerpt,
      link,
      data: { commentId: row.id },
    });
    // A reply reaches the thread's author too (unless they were already mentioned).
    if (parent?.authorId && parent.authorId !== actor.userId && !mentions.includes(parent.authorId)) {
      await this.notifications.notify(actor.tenantId, [parent.authorId], {
        type: 'comment.mentioned',
        title: `${who} replied on “${e.title}”`,
        message: excerpt,
        link,
        data: { commentId: row.id },
      });
    }
    return (await this.withNames(actor.tenantId, [{ ...row, authorName: null as string | null }]))[0]!;
  }

  async updateComment(
    actor: TenantPrincipal,
    ability: AppAbility | null,
    id: string,
    body: z.infer<typeof updateCommentBody>,
  ) {
    const c = await this.system.comment.findFirst({
      where: { id, tenantId: actor.tenantId, deletedAt: null },
    });
    if (!c) throw notFound('Comment');
    if (body.body !== undefined && c.authorId !== actor.userId)
      throw forbidden('Only the author can edit a comment');
    if (body.resolved !== undefined && c.parentId)
      throw badRequest('NOT_A_THREAD', 'Resolve the thread, not a reply');
    const row = await this.system.comment.update({
      where: { id },
      data: {
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.resolved !== undefined
          ? {
              resolvedAt: body.resolved ? new Date() : null,
              resolvedById: body.resolved ? (actor.userId ?? null) : null,
            }
          : {}),
      },
    });
    void ability;
    return (await this.withNames(actor.tenantId, [{ ...row, authorName: null as string | null }]))[0]!;
  }

  async deleteComment(actor: TenantPrincipal, ability: AppAbility | null, id: string): Promise<void> {
    const c = await this.system.comment.findFirst({
      where: { id, tenantId: actor.tenantId, deletedAt: null },
    });
    if (!c) throw notFound('Comment');
    if (c.authorId !== actor.userId && !ability?.can('manage', 'all'))
      throw forbidden('Only the author or an admin can delete a comment');
    const now = new Date();
    await this.system.comment.updateMany({
      where: { tenantId: actor.tenantId, OR: [{ id }, { parentId: id }], deletedAt: null },
      data: { deletedAt: now },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Members who can publish (OWNER/ADMIN/EDITOR), optionally limited to the given users. */
  private async publishers(tenantId: string, only?: string[]): Promise<string[]> {
    const rows = await this.system.tenantMember.findMany({
      where: {
        tenantId,
        role: { in: ['OWNER', 'ADMIN', 'EDITOR'] },
        ...(only ? { userId: { in: only } } : {}),
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private async userName(userId?: string): Promise<string> {
    if (!userId) return 'An integration';
    const u = await this.system.user.findUnique({ where: { id: userId }, select: { name: true } });
    return u?.name ?? 'Someone';
  }

  private present(
    r: {
      id: string;
      entityType: ContentEntityType;
      entityId: string;
      version: number;
      status: ReviewStatus;
      note: string | null;
      requestedById: string | null;
      reviewerIds: string[];
      decidedById: string | null;
      decidedAt: Date | null;
      decisionNote: string | null;
      createdAt: Date;
    },
    e: Entity,
  ) {
    return {
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      title: e.title,
      link: e.link,
      version: r.version,
      currentVersion: e.version,
      stale: r.version !== e.version,
      status: r.status,
      note: r.note,
      requestedById: r.requestedById,
      requestedByName: null as string | null,
      reviewerIds: r.reviewerIds,
      decidedById: r.decidedById,
      decidedByName: null as string | null,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt,
    };
  }

  /** Fills *Name fields from the matching *Id fields in one query. */
  private async withNames<
    T extends { requestedById?: string | null; decidedById?: string | null; authorId?: string | null },
  >(tenantId: string, rows: T[]): Promise<T[]> {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.requestedById, r.decidedById, r.authorId])
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (!ids.length) return rows;
    const users = await this.system.user.findMany({
      where: { id: { in: ids }, memberships: { some: { tenantId } } },
      select: { id: true, name: true },
    });
    const name = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      ...r,
      ...('requestedById' in r
        ? { requestedByName: r.requestedById ? (name.get(r.requestedById) ?? null) : null }
        : {}),
      ...('decidedById' in r
        ? { decidedByName: r.decidedById ? (name.get(r.decidedById) ?? null) : null }
        : {}),
      ...('authorId' in r ? { authorName: r.authorId ? (name.get(r.authorId) ?? null) : null } : {}),
    }));
  }
}
