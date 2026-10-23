import { AiGateway, isModelKey, type CompletionResult, type ModelKey } from '@canon/ai-gateway';
import type { RichTextDoc } from '@canon/blocks';
import { Prisma } from '@canon/db';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, notFound } from '../../common/http/api-error';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { AiContentService, parseJson, withForbidden } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { deterministicCheck, literalSubstitution, type FactValueType } from './fact-values';
import { FactsService } from './facts.service';
import { parseStoredPath, storedPath } from './mentions.service';
import { ensureTeam, type TeamRole } from './team';
import { ContentTargets, contextAround, plainOf, replaceSpan, withField, type ContentTarget, type TargetField, type TargetType } from './targets';

export const PROPAGATE_QUEUE = 'canon-propagate';

export interface SpanResult {
  mentionId: string;
  blockId: string | null;
  fieldPath: string;
  fieldLabel: string;
  locale: string;
  agent: 'Copywriter' | 'Translator';
  before: string;
  after: string | null;
  context: { before: string; after: string };
  explanation: string | null;
  verdict: 'pass' | 'uncertain' | 'fail' | 'escalated';
  issues: string[];
  /** Applied to the proposed draft (false for escalations and failed checks). */
  applied: boolean;
}

export interface ChangeExplanation {
  title: string;
  path: string;
  locale: string;
  factKey: string;
  from: string;
  to: string;
  spans: SpanResult[];
  conflict?: string;
}

interface RunInput {
  factId: string;
  siteId: string;
  version: number;
  mentionIds: string[];
}

class StepLog {
  private n = 0;
  tokens = 0;
  cost = 0;
  constructor(
    private readonly system: SystemPrismaService,
    readonly runId: string,
    private readonly tenantId: string,
  ) {}
  async add(step: { node: string; toolName?: string; toolInput?: unknown; toolOutput?: unknown; res?: CompletionResult; startedAt: number }) {
    this.n += 1;
    const tokens = step.res ? step.res.usage.inputTokens + step.res.usage.outputTokens : 0;
    const cost = step.res ? step.res.costMicroUsd / 1_000_000 : 0;
    this.tokens += tokens;
    this.cost += cost;
    await this.system.aiAgentStep.create({
      data: {
        tenantId: this.tenantId,
        runId: this.runId,
        stepNumber: this.n,
        node: step.node,
        toolName: step.toolName ?? null,
        toolInput: (step.toolInput ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        toolOutput: (step.toolOutput ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        llmResponse: step.res?.text.slice(0, 4_000) ?? null,
        tokens,
        costUsd: cost,
        durationMs: Date.now() - step.startedAt,
      },
    });
  }
}

/**
 * The multi-agent propagation team, run as a tree of agent runs inside one branch:
 *
 *   Strategist (plan: group stale/conflicting spans by page and locale; BOUND spans need nothing)
 *     ├─ Copywriter  — canon.propagate_fact per span in the site's default locale
 *     ├─ Translator  — the same for other locales (locale-aware prompt, glossary via brand voice)
 *     └─ Fact-Checker — deterministic check (new value present, old value gone) AND canon.fact_check
 *
 * Every model call is a recorded step (prompt output, tokens, cost, duration). Nothing is
 * written to content: each page/entry gets one BranchChange with the patched draft and per-span
 * explanations, and the run waits for a human to review and merge.
 */
@Injectable()
export class PropagationService implements OnApplicationBootstrap {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly facts: FactsService,
    private readonly targets: ContentTargets,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    private readonly content: AiContentService,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PropagationService.name);
  }

  onApplicationBootstrap(): void {
    if (process.env.CANON_PROPAGATE === 'off') return;
    this.queues.worker<{ runId: string }>(PROPAGATE_QUEUE, (job) => this.execute(job.data.runId), 2);
  }

  /** Opens a branch + Strategist run for the fact's stale/conflicting spans on one site. */
  async propose(actor: TenantPrincipal, factId: string, siteId: string) {
    const fact = await this.facts.get(actor.tenantId, factId);
    const impact = await this.facts.impact(actor.tenantId, factId, siteId);
    const mentionIds = impact.entities.flatMap((e) => (e.mentions as { id: string; kind: string; state: string }[]).filter((m) => m.kind === 'DETECTED' && (m.state === 'STALE' || m.state === 'CONFLICT')).map((m) => m.id));
    if (!mentionIds.length) {
      throw new ApiError('NOTHING_TO_PROPAGATE', impact.totals.bound ? 'All mentions on this site are bound tokens — they already show the new value' : 'No stale or conflicting mentions on this site', 409, { totals: impact.totals });
    }
    const team = await ensureTeam(this.system, actor.tenantId);
    const base = `canon/${fact.key}@v${fact.version}`;
    const taken = await this.system.contentBranch.findMany({ where: { siteId, name: { startsWith: base } }, select: { name: true, status: true, id: true, agentRunId: true } });
    const open = taken.find((b) => b.status === 'OPEN' || b.status === 'IN_REVIEW');
    if (open) return { branchId: open.id, runId: open.agentRunId, reused: true, mentions: mentionIds.length };
    const name = taken.length ? `${base}-${taken.length + 1}` : base;

    const run = await this.system.aiAgentRun.create({
      data: { tenantId: actor.tenantId, agentId: team.Strategist, userId: actor.userId ?? null, input: { factId, siteId, version: fact.version, mentionIds } satisfies RunInput, status: 'QUEUED' },
    });
    const branch = await this.system.contentBranch.create({
      data: { tenantId: actor.tenantId, siteId, name, description: `Propagate ${fact.key} → ${fact.displayValue}`, agentRunId: run.id, createdById: actor.userId ?? null },
    });
    await this.queues.queue(PROPAGATE_QUEUE).add('propagate', { runId: run.id }, { jobId: run.id, removeOnComplete: true, removeOnFail: 100, attempts: 1 });
    return { branchId: branch.id, runId: run.id, reused: false, mentions: mentionIds.length };
  }

  /** Public for tests: runs the team for a queued run. Idempotent via the QUEUED → RUNNING claim. */
  async execute(runId: string): Promise<void> {
    const claimed = await this.system.aiAgentRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (claimed.count === 0) return;
    const run = await this.system.aiAgentRun.findUniqueOrThrow({ where: { id: runId } });
    const branch = await this.system.contentBranch.findFirstOrThrow({ where: { agentRunId: runId } });
    const tenantId = run.tenantId;
    const input = run.input as unknown as RunInput;
    const plan = new StepLog(this.system, runId, tenantId);
    try {
      const team = await ensureTeam(this.system, tenantId);
      const agents = await this.system.aiAgent.findMany({ where: { id: { in: Object.values(team) } }, include: { model: { include: { provider: true } } } });
      const agentOf = (role: TeamRole) => agents.find((a) => a.id === team[role])!;
      const fact = await this.system.fact.findFirstOrThrow({ where: { id: input.factId, tenantId }, include: { subject: true } });
      const mentions = await this.system.factMention.findMany({ where: { id: { in: input.mentionIds }, tenantId, state: { in: ['STALE', 'CONFLICT'] } } });
      const oldVersion = Math.min(...mentions.map((m) => m.factVersionSeen), fact.version - 1);
      const old = oldVersion >= 1 ? await this.system.factVersion.findFirst({ where: { factId: fact.id, version: { lte: Math.max(1, oldVersion) } }, orderBy: { version: 'desc' } }) : null;
      const site = await this.system.site.findFirstOrThrow({ where: { id: input.siteId } });
      const voice = await this.content.voice(tenantId, site.id);

      // ── Strategist: deterministic plan (grouping is bookkeeping, not judgement) ──
      const groups = new Map<string, typeof mentions>();
      for (const m of mentions) groups.set(`${m.entityType}:${m.entityId}`, [...(groups.get(`${m.entityType}:${m.entityId}`) ?? []), m]);
      const boundCount = await this.system.factMention.count({ where: { tenantId, factId: fact.id, kind: 'BOUND' } });
      const t0 = Date.now();
      const planOut = { entities: groups.size, spans: mentions.length, bound: boundCount, locales: [...new Set(mentions.map((m) => m.locale))], from: old?.displayValue ?? '(unknown)', to: fact.displayValue };
      await plan.add({ node: 'plan', toolName: 'canon.impact_analysis', toolInput: { factKey: fact.key, siteId: site.id }, toolOutput: planOut, startedAt: t0 });

      const child = async (role: TeamRole) => {
        const r = await this.system.aiAgentRun.create({ data: { tenantId, agentId: team[role], parentRunId: runId, userId: run.userId, input: { factId: fact.id, role }, status: 'RUNNING', startedAt: new Date() } });
        return new StepLog(this.system, r.id, tenantId);
      };
      const logs: Partial<Record<TeamRole, StepLog>> = {};
      const logFor = async (role: TeamRole) => (logs[role] ??= await child(role));

      const propagatePrompt = await this.prompts.get(tenantId, 'canon.propagate_fact');
      const checkPrompt = await this.prompts.get(tenantId, 'canon.fact_check');
      const oldDisplay = old?.displayValue ?? '';
      const totals = { proposed: 0, escalated: 0, failed: 0, entities: 0 };

      for (const [, group] of groups) {
        const first = group[0]!;
        const target = await this.targets.load(tenantId, first.entityType as TargetType, first.entityId);
        if (!target) continue;
        let draft = target.draft;
        const current = new Map(target.fields.map((f) => [storedPath(f), f]));
        const spans: SpanResult[] = [];

        for (const m of group) {
          const { blockId, fieldPath } = parseStoredPath(m.fieldPath);
          const field = current.get(m.fieldPath);
          const role: 'Copywriter' | 'Translator' = m.locale === site.defaultLocale ? 'Copywriter' : 'Translator';
          const base: Omit<SpanResult, 'after' | 'explanation' | 'verdict' | 'issues' | 'applied' | 'context'> = { mentionId: m.id, blockId, fieldPath, fieldLabel: field?.label ?? fieldPath, locale: m.locale, agent: role, before: m.surfaceText };
          const plain = field ? plainOf(field) : '';
          if (!field || !plain.includes(m.surfaceText)) {
            spans.push({ ...base, after: null, context: { before: '', after: '' }, explanation: null, verdict: 'escalated', issues: ['The text changed since it was scanned'], applied: false });
            totals.escalated++;
            continue;
          }
          const ctxText = contextAround(plain, m.surfaceText);
          const agent = agentOf(role);
          const writer = await logFor(role);
          const s0 = Date.now();
          const { system, user } = this.prompts.render(propagatePrompt, {
            brandVoice: voice.brandVoice || 'clear and helpful',
            locale: m.locale,
            factKey: fact.key,
            predicate: fact.predicate,
            subject: fact.subject.canonicalName,
            oldValue: oldDisplay || '(unknown)',
            newValue: fact.displayValue,
            before: ctxText.before,
            span: m.surfaceText,
            after: ctxText.after,
          });
          let out: { action?: string; text?: unknown; explanation?: unknown; reason?: unknown } | null;
          try {
            const res = await this.gateway.complete(
              { system: withForbidden(`${agent.systemPrompt}\n\n${system}`, voice), messages: [{ role: 'user', content: user }], preferModel: modelOf(agent) ?? propagatePrompt.modelKey, responseFormat: 'json', maxTokens: 600 },
              { tenantId, userId: run.userId ?? undefined, feature: 'FACT_PROPAGATE', promptId: propagatePrompt.id, relatedEntity: { type: target.type, id: target.id }, tags: { agent: role, runId } },
            );
            out = parseJson(res.text);
            await writer.add({ node: role.toLowerCase(), toolName: 'branch.propose_change', toolInput: { mentionId: m.id, span: m.surfaceText }, toolOutput: out, res, startedAt: s0 });
          } catch (err) {
            // No writer available (outage, no keys): propose the literal value swap for a human to judge.
            const literal = literalSubstitution(m.surfaceText, oldDisplay, old?.value, fact, m.observedValue);
            out = literal ? { action: 'replace', text: literal, explanation: 'Literal substitution — AI writer unavailable, please review the wording' } : { action: 'escalate', reason: 'AI writer unavailable and no literal substitution applies' };
            await writer.add({ node: role.toLowerCase(), toolName: 'branch.propose_change', toolInput: { mentionId: m.id, span: m.surfaceText }, toolOutput: { ...out, fallback: true, error: err instanceof Error ? err.message.slice(0, 200) : 'unavailable' }, startedAt: s0 });
          }

          if (out?.action !== 'replace' || typeof out.text !== 'string' || !out.text.trim()) {
            spans.push({ ...base, after: null, context: ctxText, explanation: typeof out?.reason === 'string' ? out.reason : null, verdict: 'escalated', issues: [typeof out?.reason === 'string' ? out.reason : 'The writer could not make a local edit'], applied: false });
            totals.escalated++;
            continue;
          }
          const proposed = out.text.trim();
          const verdict = await this.check(tenantId, run.userId, logFor, agentOf('Fact-Checker'), checkPrompt, { fact, oldDisplay, oldValue: old?.value, original: `${ctxText.before}${m.surfaceText}${ctxText.after}`, proposed: `${ctxText.before}${proposed}${ctxText.after}`, span: proposed, target, runId });

          let applied = false;
          if (verdict.verdict !== 'fail') {
            const f = current.get(m.fieldPath)!;
            const next = replaceSpan(f, m.surfaceText, proposed);
            if (next) {
              draft = withField({ type: target.type, draft }, blockId, fieldPath, next);
              current.set(m.fieldPath, { ...f, value: next as string | RichTextDoc } as TargetField);
              applied = true;
            } else verdict.issues.push('The span crosses formatting; apply it manually');
          }
          spans.push({ ...base, after: proposed, context: ctxText, explanation: typeof out.explanation === 'string' ? out.explanation : null, verdict: applied ? verdict.verdict : verdict.verdict === 'fail' ? 'fail' : 'escalated', issues: verdict.issues, applied });
          if (applied) totals.proposed++;
          else if (verdict.verdict === 'fail') totals.failed++;
          else totals.escalated++;
        }

        totals.entities++;
        const explanation: ChangeExplanation = { title: target.title, path: target.path, locale: target.locale, factKey: fact.key, from: oldDisplay, to: fact.displayValue, spans };
        const patch = spans.some((s) => s.applied) ? { draft } : { draft: null };
        await this.system.branchChange.upsert({
          where: { branchId_entityType_entityId: { branchId: branch.id, entityType: target.type, entityId: target.id } },
          create: { tenantId, branchId: branch.id, entityType: target.type, entityId: target.id, baseVersion: target.version, patch: patch as Prisma.InputJsonValue, aiExplanation: explanation as unknown as Prisma.InputJsonValue },
          update: { baseVersion: target.version, patch: patch as Prisma.InputJsonValue, aiExplanation: explanation as unknown as Prisma.InputJsonValue, status: 'PROPOSED' },
        });
      }

      const all = [plan, ...Object.values(logs)];
      const tokens = all.reduce((n, l) => n + l.tokens, 0);
      const cost = all.reduce((n, l) => n + l.cost, 0);
      for (const l of Object.values(logs)) await this.system.aiAgentRun.update({ where: { id: l.runId }, data: { status: 'COMPLETED', completedAt: new Date(), totalTokens: l.tokens, costUsd: l.cost } });
      const summary = { ...totals, bound: boundCount, from: oldDisplay, to: fact.displayValue, factKey: fact.key, costUsd: Math.round(cost * 1e6) / 1e6, tokens };
      // Content always waits for a human: the team proposes, people dispose.
      await this.system.aiAgentRun.update({ where: { id: runId }, data: { status: 'WAITING_HUMAN', result: summary, totalTokens: tokens, costUsd: cost } });
      await this.system.contentBranch.update({ where: { id: branch.id }, data: { status: 'IN_REVIEW', aiSummary: summary } });
    } catch (err) {
      this.logger.error({ err, runId }, 'canon.propagation_failed');
      const message = err instanceof Error ? err.message.slice(0, 300) : 'failed';
      await this.system.aiAgentRun.update({ where: { id: runId }, data: { status: 'FAILED', completedAt: new Date(), result: { error: message } } });
      await this.system.contentBranch.update({ where: { id: branch.id }, data: { aiSummary: { error: message } } });
    }
  }

  /** Deterministic rule first (cheap, can't be argued with), then the Fact-Checker's verdict. */
  private async check(
    tenantId: string,
    userId: string | null,
    logFor: (r: TeamRole) => Promise<StepLog>,
    agent: { systemPrompt: string; model: { name: string; provider: { name: string } } | null },
    prompt: Awaited<ReturnType<PromptRegistry['get']>>,
    x: { fact: { key: string; displayValue: string; valueType: string; value: unknown; subject: { canonicalName: string } }; oldDisplay: string; oldValue: unknown; original: string; proposed: string; span: string; target: ContentTarget; runId: string },
  ): Promise<{ verdict: 'pass' | 'uncertain' | 'fail'; issues: string[] }> {
    const det = deterministicCheck(x.span, x.oldDisplay, { valueType: x.fact.valueType as FactValueType, value: x.fact.value, displayValue: x.fact.displayValue }, x.oldValue);
    const log = await logFor('Fact-Checker');
    const s0 = Date.now();
    if (!det.pass) {
      await log.add({ node: 'fact-checker', toolName: 'branch.review_change', toolInput: { proposed: x.span }, toolOutput: { verdict: 'fail', issues: det.issues, deterministic: true }, startedAt: s0 });
      return { verdict: 'fail', issues: det.issues };
    }
    try {
      const { system, user } = this.prompts.render(prompt, { fact: `${x.fact.key} (${x.fact.subject.canonicalName}) = ${x.fact.displayValue}`, source: 'Canonical fact graph', original: x.original, proposed: x.proposed });
      const res = await this.gateway.complete(
        { system: `${agent.systemPrompt}\n\n${system}`, messages: [{ role: 'user', content: user }], preferModel: modelOf(agent) ?? prompt.modelKey, responseFormat: 'json', maxTokens: 300 },
        { tenantId, userId: userId ?? undefined, feature: 'FACT_CHECK', promptId: prompt.id, relatedEntity: { type: x.target.type, id: x.target.id }, tags: { agent: 'Fact-Checker', runId: x.runId } },
      );
      const out = parseJson<{ verdict?: unknown; issues?: unknown }>(res.text);
      const verdict = out?.verdict === 'pass' || out?.verdict === 'fail' ? out.verdict : 'uncertain';
      const issues = Array.isArray(out?.issues) ? out.issues.filter((i): i is string => typeof i === 'string').slice(0, 5) : [];
      await log.add({ node: 'fact-checker', toolName: 'branch.review_change', toolInput: { proposed: x.span }, toolOutput: { verdict, issues }, res, startedAt: s0 });
      return { verdict, issues };
    } catch (err) {
      // No checker available: the deterministic pass stands, but a human must look.
      await log.add({ node: 'fact-checker', toolName: 'branch.review_change', toolInput: { proposed: x.span }, toolOutput: { verdict: 'uncertain', error: err instanceof Error ? err.message : 'unavailable' }, startedAt: s0 });
      return { verdict: 'uncertain', issues: ['Automatic fact-check unavailable — review manually'] };
    }
  }

  async run(tenantId: string, runId: string) {
    const run = await this.system.aiAgentRun.findFirst({
      where: { id: runId, tenantId },
      include: { agent: { select: { name: true, type: true } }, steps: { orderBy: { stepNumber: 'asc' } }, children: { include: { agent: { select: { name: true, type: true } }, steps: { orderBy: { stepNumber: 'asc' } } } } },
    });
    if (!run) throw notFound('Agent run');
    return run;
  }
}

function modelOf(agent: { model: { name: string; provider: { name: string } } | null }): ModelKey | undefined {
  const key = agent.model ? `${agent.model.provider.name}/${agent.model.name}` : undefined;
  return key && isModelKey(key) ? key : undefined;
}
