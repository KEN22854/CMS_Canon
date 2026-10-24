import { AiGateway } from '@canon/ai-gateway';
import type { BlockPatch } from '@canon/edge';
import { applyBlockPatch } from '@canon/edge';
import { Prisma, type AbTest } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, conflict, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ctx, parseJson } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { PagesService } from '../pages/pages.service';
import type { CreateExperimentBody, UpdateExperimentBody } from './experiences.dto';
import { PatchValidator } from './patch-validator';
import { analyze, type Analysis } from './stats';

export interface Variant {
  id: string;
  name: string;
  weight: number;
  patch: BlockPatch;
}

export type Decision = 'declare_winner' | 'keep_running' | 'stop_no_effect' | 'stop_control_wins';

export interface Recommendation {
  decision: Decision;
  winnerVariantId: string | null;
  reasoning: string;
  nextSteps: string[];
  generatedBy: 'ai' | 'rules';
  overridden?: string;
  at: string;
}

const withControl = (variants: Variant[]): Variant[] => (variants.some((v) => v.id === 'control') ? variants : [{ id: 'control', name: 'Original', weight: variants[0]?.weight ?? 1, patch: {} }, ...variants]);

@Injectable()
export class ExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pages: PagesService,
    private readonly patches: PatchValidator,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
  ) {}

  async list(tenantId: string, siteId: string, pageId?: string) {
    const rows = await this.prisma.forTenant({ tenantId }).abTest.findMany({
      where: { tenantId, page: { siteId, deletedAt: null }, ...(pageId ? { pageId } : {}) },
      include: { page: { select: { id: true, title: true, fullPath: true, locale: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map(async (t) => ({ ...present(t), page: t.page, results: t.status === 'DRAFT' ? null : summarize(await this.analysis(tenantId, t)) })));
  }

  async get(tenantId: string, id: string) {
    const t = await this.prisma.forTenant({ tenantId }).abTest.findFirst({ where: { id, tenantId }, include: { page: { select: { id: true, siteId: true, title: true, fullPath: true, locale: true, publishedVersion: true } } } });
    if (!t) throw notFound('Experiment');
    return t;
  }

  async detail(tenantId: string, id: string) {
    const t = await this.get(tenantId, id);
    return { ...present(t), page: t.page, results: await this.analysis(tenantId, t) };
  }

  async create(actor: TenantPrincipal, siteId: string, pageId: string, body: CreateExperimentBody) {
    const page = await this.pages.get(actor.tenantId, siteId, pageId);
    const variants = withControl(body.variants as Variant[]);
    await this.validateVariants(page, variants);
    const t = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
      tx.abTest.create({ data: { tenantId: actor.tenantId, pageId, name: body.name, goalMetric: body.goalMetric, trafficAllocation: body.trafficAllocation, variants: variants as unknown as Prisma.InputJsonValue } }),
    );
    await this.audit.record({ tenantId: actor.tenantId, action: 'experiment.created', entityType: 'AbTest', entityId: t.id, changes: { pageId, variants: variants.length } }, actor);
    return this.detail(actor.tenantId, t.id);
  }

  /** Variants are frozen once a test runs: changing arms mid-test invalidates the statistics. */
  async update(actor: TenantPrincipal, id: string, body: UpdateExperimentBody) {
    const t = await this.get(actor.tenantId, id);
    if (body.variants && t.status !== 'DRAFT') throw conflict('Variants can only change while the experiment is a draft');
    const data: Prisma.AbTestUpdateInput = {};
    if (body.name) data.name = body.name;
    if (body.goalMetric) {
      if (t.status !== 'DRAFT') throw conflict('The goal can only change while the experiment is a draft');
      data.goalMetric = body.goalMetric;
    }
    if (body.trafficAllocation !== undefined) data.trafficAllocation = body.trafficAllocation;
    if (body.variants) {
      const page = await this.pages.get(actor.tenantId, t.page.siteId, t.pageId);
      const variants = withControl(body.variants as Variant[]);
      await this.validateVariants(page, variants);
      data.variants = variants as unknown as Prisma.InputJsonValue;
    }
    await this.write(actor, t, data);
    return this.detail(actor.tenantId, id);
  }

  async start(actor: TenantPrincipal, id: string) {
    const t = await this.get(actor.tenantId, id);
    if (t.status === 'RUNNING') return this.detail(actor.tenantId, id);
    if (t.status === 'COMPLETED') throw conflict('A completed experiment cannot restart — duplicate it instead');
    if (!t.page.publishedVersion) throw new ApiError('PAGE_NOT_PUBLISHED', 'Publish the page before testing it', 409);
    const running = await this.prisma.forTenant({ tenantId: actor.tenantId }).abTest.findFirst({ where: { pageId: t.pageId, status: 'RUNNING', NOT: { id } } });
    if (running) throw conflict(`"${running.name}" is already running on this page`);
    // Re-check against the *current* published page: it may have changed since the draft test was set up.
    const page = await this.pages.get(actor.tenantId, t.page.siteId, t.pageId);
    await this.validateVariants(page, t.variants as unknown as Variant[]);
    await this.write(actor, t, { status: 'RUNNING', startedAt: t.startedAt ?? new Date() });
    return this.detail(actor.tenantId, id);
  }

  async pause(actor: TenantPrincipal, id: string) {
    const t = await this.get(actor.tenantId, id);
    if (t.status !== 'RUNNING') throw conflict('Only a running experiment can be paused');
    await this.write(actor, t, { status: 'PAUSED' });
    return this.detail(actor.tenantId, id);
  }

  async complete(actor: TenantPrincipal, ability: AppAbility, id: string, winnerVariantId: string | undefined, applyToDraft: boolean) {
    const t = await this.get(actor.tenantId, id);
    const variants = t.variants as unknown as Variant[];
    const winner = winnerVariantId ? variants.find((v) => v.id === winnerVariantId) : undefined;
    if (winnerVariantId && !winner) throw notFound('Variant');
    await this.write(actor, t, { status: 'COMPLETED', endedAt: new Date(), winnerVariantId: winner?.id ?? null });
    if (applyToDraft && winner && Object.keys(winner.patch).length) {
      const page = await this.pages.get(actor.tenantId, t.page.siteId, t.pageId);
      await this.pages.update(actor, ability, t.page.siteId, t.pageId, { expectedVersion: page.version, content: applyBlockPatch(page.content as never, winner.patch) });
    }
    return this.detail(actor.tenantId, id);
  }

  /**
   * AI reads the statistics and proposes what to do; the rules decide what it is *allowed* to
   * propose. A model that wants to declare a winner before significance and sample size is
   * overridden (and says so) — stopping early is how tests produce false winners.
   */
  async recommend(actor: TenantPrincipal, id: string): Promise<Recommendation> {
    const t = await this.get(actor.tenantId, id);
    const a = await this.analysis(actor.tenantId, t);
    const rules = ruleRecommendation(a);
    let rec: Recommendation = rules;
    try {
      const prompt = await this.prompts.get(actor.tenantId, 'experiments.recommend');
      const variants = (t.variants as unknown as Variant[]).map((v) => ({ id: v.id, name: v.name, changes: v.patch }));
      const { system, user } = this.prompts.render(prompt, { experiment: JSON.stringify({ name: t.name, goal: t.goalMetric, startedAt: t.startedAt, variants }), stats: JSON.stringify(a) });
      const res = await this.gateway.complete({ system, messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 700 }, ctx(actor, 'SUMMARIZE', prompt.id));
      const out = parseJson<{ decision?: unknown; winnerVariantId?: unknown; reasoning?: unknown; nextSteps?: unknown }>(res.text);
      const decision = (['declare_winner', 'keep_running', 'stop_no_effect', 'stop_control_wins'] as const).find((d) => d === out?.decision);
      if (decision && typeof out?.reasoning === 'string') {
        const allowed = decision === rules.decision || (decision === 'keep_running' && rules.decision !== 'keep_running');
        rec = {
          decision: allowed ? decision : rules.decision,
          winnerVariantId: allowed && decision === 'declare_winner' ? rules.winnerVariantId : rules.decision === 'declare_winner' ? rules.winnerVariantId : null,
          reasoning: out.reasoning.slice(0, 800),
          nextSteps: Array.isArray(out.nextSteps) ? out.nextSteps.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 200)).slice(0, 4) : rules.nextSteps,
          generatedBy: 'ai',
          ...(allowed ? {} : { overridden: `The model suggested "${decision}", but the statistics only support "${rules.decision}".` }),
          at: new Date().toISOString(),
        };
      }
    } catch {
      // No model: the rule-based recommendation stands on its own.
    }
    await this.prisma.rawForTenant({ tenantId: actor.tenantId }, (tx) => tx.abTest.update({ where: { id }, data: { aiRecommendation: rec as unknown as Prisma.InputJsonValue } }));
    return rec;
  }

  async analysis(tenantId: string, t: AbTest): Promise<Analysis> {
    const rows = await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<{ variantId: string; exposures: bigint; conversions: bigint }[]>`
      WITH e AS (SELECT DISTINCT "variantId", "visitorId" FROM ab_test_events WHERE "testId" = ${t.id} AND event = 'exposure'),
           c AS (SELECT DISTINCT "variantId", "visitorId" FROM ab_test_events WHERE "testId" = ${t.id} AND event = 'conversion')
      SELECT e."variantId", count(*)::bigint AS exposures, count(c."visitorId")::bigint AS conversions
      FROM e LEFT JOIN c ON c."variantId" = e."variantId" AND c."visitorId" = e."visitorId"
      GROUP BY 1`);
    const counts = new Map(rows.map((r) => [r.variantId, r]));
    return analyze((t.variants as unknown as Variant[]).map((v) => ({ id: v.id, name: v.name, exposures: Number(counts.get(v.id)?.exposures ?? 0), conversions: Number(counts.get(v.id)?.conversions ?? 0) })));
  }

  private async validateVariants(page: { id: string; publishedVersion: number | null; content: unknown }, variants: Variant[]): Promise<void> {
    const ids = new Set<string>();
    for (const v of variants) {
      if (ids.has(v.id)) throw new ApiError('INVALID_PATCH', `Duplicate variant id "${v.id}"`, 422);
      ids.add(v.id);
    }
    if (variants.length < 2) throw new ApiError('INVALID_PATCH', 'An experiment needs at least one variant besides the original', 422);
    if (!variants.some((v) => v.weight > 0)) throw new ApiError('INVALID_PATCH', 'At least one variant needs traffic', 422);
    const base = await this.patches.baseContent(page as never);
    for (const v of variants) await this.patches.validate(base, v.patch, `Variant "${v.name}"`);
  }

  private async write(actor: TenantPrincipal, t: { id: string; page: { siteId: string } }, data: Prisma.AbTestUpdateInput) {
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.abTest.update({ where: { id: t.id }, data });
      // Running set or variants changed: the proxy's runtime config and cached variants must refresh.
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'AbTest', aggregateId: t.id, type: 'ExperimentChanged', payload: { siteId: t.page.siteId, testId: t.id } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'experiment.updated', entityType: 'AbTest', entityId: t.id, changes: data as Prisma.InputJsonObject }, actor);
  }
}

export function ruleRecommendation(a: Analysis): Recommendation {
  const at = new Date().toISOString();
  const leader = a.variants.find((v) => v.id === a.leaderId);
  switch (a.verdict) {
    case 'winner':
      return { decision: 'declare_winner', winnerVariantId: a.leaderId, reasoning: `"${leader?.name}" converts at ${pct(leader?.rate)} vs control, p=${leader?.pValue?.toFixed(4)}, ${Math.round((leader?.probBeatControl ?? 0) * 100)}% probability to beat control, planned sample reached.`, nextSteps: ['Apply the winning variant to the page draft and publish it.', 'Test the next element on the same page.'], generatedBy: 'rules', at };
    case 'control_wins':
      return { decision: 'stop_control_wins', winnerVariantId: 'control', reasoning: 'Every challenger performs significantly worse than the original.', nextSteps: ['Keep the original.', 'Try a bolder alternative hypothesis.'], generatedBy: 'rules', at };
    case 'no_difference':
      return { decision: 'stop_no_effect', winnerVariantId: null, reasoning: 'The planned sample size is reached and no variant differs significantly from the original.', nextSteps: ['Keep the simpler version.', 'Test a larger change — small wording tweaks rarely move conversions.'], generatedBy: 'rules', at };
    default:
      return { decision: 'keep_running', winnerVariantId: null, reasoning: `${Math.round(a.progress * 100)}% of the planned ${a.requiredPerVariant} visitors per variant collected — too early to call.`, nextSteps: ['Keep the test running until the planned sample size is reached.'], generatedBy: 'rules', at };
  }
}

const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 1000) / 10}%`;

function summarize(a: Analysis) {
  return { verdict: a.verdict, progress: a.progress, leaderId: a.leaderId, exposures: a.variants.reduce((n, v) => n + v.exposures, 0) };
}

function present(t: AbTest) {
  return { id: t.id, pageId: t.pageId, name: t.name, status: t.status, goalMetric: t.goalMetric, trafficAllocation: t.trafficAllocation, variants: t.variants as unknown as Variant[], startedAt: t.startedAt, endedAt: t.endedAt, winnerVariantId: t.winnerVariantId, aiRecommendation: t.aiRecommendation as Recommendation | null, createdAt: t.createdAt };
}
