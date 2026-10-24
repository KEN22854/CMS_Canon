import { matchesSegment, segmentRulesSchema, type BlockPatch, type SegmentRules, type VisitorContext } from '@canon/edge';
import { Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, conflict, notFound } from '../../common/http/api-error';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { PagesService } from '../pages/pages.service';
import { SitesService } from '../sites/sites.service';
import type { PersonalizationBody, SegmentBody } from './experiences.dto';
import { PatchValidator } from './patch-validator';

@Injectable()
export class PersonalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly pages: PagesService,
    private readonly patches: PatchValidator,
    private readonly outbox: Outbox,
  ) {}

  // ── segments ───────────────────────────────────────────────────────────────

  async segments(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).segment.findMany({ where: { siteId, deletedAt: null }, orderBy: { name: 'asc' }, include: { _count: { select: { personalizations: true } } } });
    return rows.map((s) => ({ id: s.id, name: s.name, description: s.description, rules: s.rules as SegmentRules, aiGenerated: s.aiGenerated, personalizations: s._count.personalizations, updatedAt: s.updatedAt }));
  }

  async segment(tenantId: string, siteId: string, id: string) {
    const s = await this.prisma.forTenant({ tenantId }).segment.findFirst({ where: { id, siteId, tenantId, deletedAt: null } });
    if (!s) throw notFound('Segment');
    return s;
  }

  async createSegment(actor: TenantPrincipal, siteId: string, body: SegmentBody) {
    await this.sites.get(actor.tenantId, siteId);
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    if (await db.segment.findFirst({ where: { siteId, name: body.name, deletedAt: null } })) throw conflict(`A segment named "${body.name}" exists`);
    const s = await this.write(actor, siteId, (tx) => tx.segment.create({ data: { tenantId: actor.tenantId, siteId, name: body.name, description: body.description ?? null, rules: body.rules as unknown as Prisma.InputJsonValue } }));
    return { id: s.id, name: s.name, description: s.description, rules: s.rules, aiGenerated: s.aiGenerated, personalizations: 0, updatedAt: s.updatedAt };
  }

  async updateSegment(actor: TenantPrincipal, siteId: string, id: string, body: Partial<SegmentBody>) {
    await this.segment(actor.tenantId, siteId, id);
    await this.write(actor, siteId, (tx) => tx.segment.update({ where: { id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.rules ? { rules: body.rules as unknown as Prisma.InputJsonValue } : {}) } }));
    return (await this.segments(actor.tenantId, siteId)).find((s) => s.id === id)!;
  }

  async deleteSegment(actor: TenantPrincipal, siteId: string, id: string): Promise<void> {
    await this.segment(actor.tenantId, siteId, id);
    await this.write(actor, siteId, async (tx) => {
      await tx.personalization.deleteMany({ where: { segmentId: id } });
      await tx.segment.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }

  /** Dry-run a rule against a hand-made visitor ("would a German mobile visitor match?"). */
  test(rules: SegmentRules, context: Omit<VisitorContext, 'visitorId'>) {
    return { matches: matchesSegment(segmentRulesSchema.parse(rules), { ...context, visitorId: 'preview' }) };
  }

  // ── page personalizations ──────────────────────────────────────────────────

  async forPage(tenantId: string, siteId: string, pageId: string) {
    await this.pages.get(tenantId, siteId, pageId);
    const rows = await this.prisma.forTenant({ tenantId }).personalization.findMany({ where: { pageId }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }], include: { segment: { select: { id: true, name: true, deletedAt: true } } } });
    return rows.filter((r) => !r.segment.deletedAt).map((r) => ({ id: r.id, segment: { id: r.segment.id, name: r.segment.name }, priority: r.priority, status: r.status, patch: r.patch as BlockPatch, updatedAt: r.updatedAt }));
  }

  /** One personalization per (page, segment); saving again replaces it. */
  async upsert(actor: TenantPrincipal, siteId: string, pageId: string, body: PersonalizationBody) {
    const page = await this.pages.get(actor.tenantId, siteId, pageId);
    const seg = await this.segment(actor.tenantId, siteId, body.segmentId);
    await this.patches.validate(await this.patches.baseContent(page), body.patch, `Personalization for "${seg.name}"`);
    await this.write(actor, siteId, (tx) =>
      tx.personalization.upsert({
        where: { pageId_segmentId: { pageId, segmentId: seg.id } },
        create: { tenantId: actor.tenantId, siteId, pageId, segmentId: seg.id, priority: body.priority, patch: body.patch as Prisma.InputJsonValue, status: body.status },
        update: { priority: body.priority, patch: body.patch as Prisma.InputJsonValue, status: body.status },
      }),
    );
    return this.forPage(actor.tenantId, siteId, pageId);
  }

  async remove(actor: TenantPrincipal, siteId: string, pageId: string, id: string) {
    const row = await this.prisma.forTenant({ tenantId: actor.tenantId }).personalization.findFirst({ where: { id, pageId, siteId } });
    if (!row) throw notFound('Personalization');
    await this.write(actor, siteId, (tx) => tx.personalization.delete({ where: { id } }));
    return this.forPage(actor.tenantId, siteId, pageId);
  }

  private write<T>(actor: TenantPrincipal, siteId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma
      .rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
        const out = await fn(tx);
        await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Site', aggregateId: siteId, type: 'PersonalizationChanged', payload: { siteId } });
        return out;
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ApiError('CONFLICT', 'Already exists', 409);
        throw err;
      });
  }
}
