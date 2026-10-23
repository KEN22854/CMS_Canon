import type { RichTextDoc } from '@canon/blocks';
import { Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, conflict, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EntriesService } from '../collections/entries.service';
import { PagesService } from '../pages/pages.service';
import type { ReviewChangeBody } from './canon.dto';
import { FactsService } from './facts.service';
import { MentionsService } from './mentions.service';
import type { ChangeExplanation } from './propagation.service';
import { ContentTargets, replaceSpan, withField, type TargetField, type TargetType } from './targets';
import { storedPath } from './mentions.service';

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: FactsService,
    private readonly mentions: MentionsService,
    private readonly targets: ContentTargets,
    private readonly pages: PagesService,
    private readonly entries: EntriesService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, siteId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).contentBranch.findMany({
      where: { tenantId, siteId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { changes: true } }, agentRun: { select: { id: true, status: true } }, createdBy: { select: { name: true } } },
    });
    return rows.map((b) => ({ id: b.id, name: b.name, description: b.description, status: b.status, summary: b.aiSummary, changes: b._count.changes, run: b.agentRun, createdBy: b.createdBy?.name ?? null, createdAt: b.createdAt, mergedAt: b.mergedAt }));
  }

  async get(tenantId: string, branchId: string) {
    const b = await this.prisma.forTenant({ tenantId }).contentBranch.findFirst({
      where: { id: branchId, tenantId },
      include: { changes: { orderBy: { createdAt: 'asc' } }, agentRun: { select: { id: true, status: true, costUsd: true, totalTokens: true } }, createdBy: { select: { name: true } }, mergedBy: { select: { name: true } } },
    });
    if (!b) throw notFound('Branch');
    const described = await this.facts.describe(tenantId, b.changes.map((c) => ({ type: c.entityType as TargetType, id: c.entityId })));
    return {
      id: b.id,
      siteId: b.siteId,
      name: b.name,
      description: b.description,
      status: b.status,
      summary: b.aiSummary,
      run: b.agentRun ? { ...b.agentRun, costUsd: Number(b.agentRun.costUsd) } : null,
      createdBy: b.createdBy?.name ?? null,
      mergedBy: b.mergedBy?.name ?? null,
      mergedAt: b.mergedAt,
      createdAt: b.createdAt,
      changes: b.changes.map((c) => ({
        id: c.id,
        entityType: c.entityType,
        entityId: c.entityId,
        entity: described.get(`${c.entityType}:${c.entityId}`) ?? null,
        status: c.status,
        baseVersion: c.baseVersion,
        applicable: Boolean((c.patch as { draft?: unknown } | null)?.draft),
        explanation: c.aiExplanation as unknown as ChangeExplanation,
      })),
    };
  }

  /**
   * Accept/reject one page's change. Overrides let a reviewer rewrite a span by hand; the patch
   * is rebuilt from the current draft, so the base version must not have moved meanwhile.
   */
  async review(actor: TenantPrincipal, branchId: string, changeId: string, body: ReviewChangeBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const change = await db.branchChange.findFirst({ where: { id: changeId, branchId, tenantId: actor.tenantId }, include: { branch: true } });
    if (!change) throw notFound('Change');
    if (change.branch.status === 'MERGED' || change.branch.status === 'CLOSED') throw conflict('This branch is no longer open');
    let patch = change.patch as { draft: unknown };
    let explanation = change.aiExplanation as unknown as ChangeExplanation;
    if (body.overrides && Object.keys(body.overrides).length) {
      const t = await this.targets.load(actor.tenantId, change.entityType as TargetType, change.entityId);
      if (!t) throw notFound('Content');
      if (t.version !== change.baseVersion) throw new ApiError('STALE_BASE', 'The page changed after the proposal — re-run propagation', 409);
      const fields = new Map(t.fields.map((f) => [storedPath(f), f]));
      let draft = t.draft;
      const spans = explanation.spans.map((s) => {
        const text = body.overrides![s.mentionId] ?? (s.applied ? s.after : null);
        if (text === null || text === undefined) return { ...s, applied: false };
        const key = storedPath({ blockId: s.blockId, fieldPath: s.fieldPath });
        const f = fields.get(key);
        const next = f ? replaceSpan(f, s.before, text) : null;
        if (!f || !next) return { ...s, applied: false, issues: [...s.issues, 'Could not apply the edited text'] };
        draft = withField({ type: t.type, draft }, s.blockId, s.fieldPath, next);
        fields.set(key, { ...f, value: next as string | RichTextDoc } as TargetField);
        return { ...s, after: text, applied: true, verdict: body.overrides![s.mentionId] ? ('pass' as const) : s.verdict, explanation: body.overrides![s.mentionId] ? 'Edited by reviewer' : s.explanation };
      });
      explanation = { ...explanation, spans };
      patch = { draft: spans.some((s) => s.applied) ? draft : null };
    }
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
      tx.branchChange.update({ where: { id: changeId }, data: { status: body.status, patch: patch as Prisma.InputJsonValue, aiExplanation: explanation as unknown as Prisma.InputJsonValue } }),
    );
    return this.get(actor.tenantId, branchId);
  }

  /**
   * Applies accepted changes with compare-and-swap on each page's base version: a page edited
   * after the proposal is reported as a conflict instead of being overwritten. Mentions are then
   * re-scanned (deterministic, instant) so the Canon inbox reflects the merged text.
   */
  async merge(actor: TenantPrincipal, ability: AppAbility, branchId: string, publish: boolean) {
    const b = await this.get(actor.tenantId, branchId);
    if (b.status === 'MERGED' || b.status === 'CLOSED') throw conflict('This branch is no longer open');
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const changes = await db.branchChange.findMany({ where: { branchId, status: 'ACCEPTED' } });
    if (!changes.length) throw new ApiError('NOTHING_ACCEPTED', 'Accept at least one change before merging', 409);
    const results: { changeId: string; entityId: string; ok: boolean; error?: string; published?: boolean }[] = [];
    for (const c of changes) {
      const draft = (c.patch as { draft?: unknown } | null)?.draft;
      const entity = b.changes.find((x) => x.id === c.id)?.entity;
      if (!draft || !entity) {
        results.push({ changeId: c.id, entityId: c.entityId, ok: false, error: 'Nothing to apply' });
        continue;
      }
      try {
        await this.facts.writeDraft(actor, ability, c.entityType as TargetType, c.entityId, entity.siteId, entity.collectionId, c.baseVersion, draft);
        let published = false;
        if (publish && entity.status === 'PUBLISHED') {
          if (c.entityType === 'PAGE') await this.pages.publish(actor, ability, entity.siteId, c.entityId, `Canon: ${b.name}`);
          else await this.entries.publish(actor, ability, entity.siteId, entity.collectionId!, c.entityId, `Canon: ${b.name}`);
          published = true;
        }
        await this.mentions.index(actor.tenantId, c.entityType as TargetType, c.entityId, { llm: false });
        results.push({ changeId: c.id, entityId: c.entityId, ok: true, published });
      } catch (err) {
        const message = err instanceof ApiError && err.code === 'VERSION_CONFLICT' ? 'The page was edited after the proposal' : err instanceof Error ? err.message : 'failed';
        results.push({ changeId: c.id, entityId: c.entityId, ok: false, error: message });
      }
    }
    const failed = results.filter((r) => !r.ok);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.contentBranch.update({ where: { id: branchId }, data: { status: failed.length ? 'CONFLICTED' : 'MERGED', mergedById: actor.userId ?? null, mergedAt: new Date() } });
      if (b.run && !failed.length) await tx.aiAgentRun.update({ where: { id: b.run.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'branch.merged', entityType: 'Branch', entityId: branchId, changes: { applied: results.length - failed.length, failed: failed.length, publish } }, actor);
    return { results, branch: await this.get(actor.tenantId, branchId) };
  }

  async close(actor: TenantPrincipal, branchId: string) {
    const b = await this.get(actor.tenantId, branchId);
    if (b.status === 'MERGED') throw conflict('A merged branch cannot be closed');
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.contentBranch.update({ where: { id: branchId }, data: { status: 'CLOSED' } });
      if (b.run && b.run.status !== 'COMPLETED' && b.run.status !== 'FAILED') await tx.aiAgentRun.update({ where: { id: b.run.id }, data: { status: 'CANCELLED', completedAt: new Date() } });
    });
    return this.get(actor.tenantId, branchId);
  }
}
