import { AiGateway, isModelKey, renderTemplate, type ModelKey } from '@canon/ai-gateway';
import { Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, notFound } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { meta } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import type { PlaygroundBody, PromptTestBody, PromptVersionBody } from './studio.dto';

/**
 * Prompt Manager. Platform prompts (tenantId NULL) are read-only templates; a tenant edits by
 * creating its own versions under the same name, which the registry prefers. Activation is a
 * pointer move, so rolling back a bad prompt is one click and every generation stays attributable
 * to the exact version that produced it (ai_generations.promptId).
 */
@Injectable()
export class PromptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PromptRegistry,
    private readonly gateway: AiGateway,
  ) {}

  async list(tenantId: string) {
    const rows = await this.prisma.forTenant({ tenantId }).aiPrompt.findMany({ where: { OR: [{ tenantId }, { tenantId: null }] }, orderBy: [{ name: 'asc' }, { version: 'desc' }] });
    const byName = new Map<string, typeof rows>();
    for (const r of rows) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const stats = await this.prisma.forTenant({ tenantId }).aiGeneration.groupBy({ by: ['promptId'], where: { tenantId, promptId: { in: rows.map((r) => r.id) } }, _count: true, _sum: { costUsd: true } });
    return [...byName.entries()].map(([name, versions]) => {
      const active = versions.find((v) => v.tenantId === tenantId && v.isActive) ?? versions.find((v) => v.tenantId === null && v.isActive);
      const s = stats.filter((x) => versions.some((v) => v.id === x.promptId));
      return {
        name,
        feature: versions[0]!.feature,
        active: active ? { id: active.id, version: active.version, scope: active.tenantId ? 'tenant' : 'global', modelKey: active.modelKey } : null,
        versions: versions.length,
        overridden: versions.some((v) => v.tenantId === tenantId),
        generations: s.reduce((n, x) => n + x._count, 0),
        costUsd: s.reduce((n, x) => n + Number(x._sum.costUsd ?? 0), 0),
      };
    });
  }

  async get(tenantId: string, name: string) {
    const db = this.prisma.forTenant({ tenantId });
    const versions = await db.aiPrompt.findMany({ where: { name, OR: [{ tenantId }, { tenantId: null }] }, orderBy: { version: 'desc' }, include: { createdBy: { select: { name: true } } } });
    if (!versions.length) throw notFound(`Prompt "${name}"`);
    const resolved = await this.registry.get(tenantId, name).catch(() => null);
    const runs = await db.aiPromptRun.findMany({ where: { tenantId, promptId: { in: versions.map((v) => v.id) } }, orderBy: { createdAt: 'desc' }, take: 20 });
    const gens = await db.aiGeneration.groupBy({ by: ['promptId'], where: { tenantId, promptId: { in: versions.map((v) => v.id) } }, _count: true, _avg: { latencyMs: true }, _sum: { costUsd: true } });
    return {
      name,
      feature: versions[0]!.feature,
      activeId: resolved?.id ?? null,
      versions: versions.map((v) => {
        const g = gens.find((x) => x.promptId === v.id);
        return {
          id: v.id,
          version: v.version,
          scope: v.tenantId ? 'tenant' : 'global',
          isActive: v.isActive,
          system: v.system ?? '',
          template: v.template,
          variables: v.variables,
          modelKey: v.modelKey,
          createdBy: v.createdBy?.name ?? null,
          createdAt: v.createdAt,
          stats: { generations: g?._count ?? 0, avgLatencyMs: Math.round(g?._avg.latencyMs ?? 0), costUsd: Number(g?._sum.costUsd ?? 0) },
        };
      }),
      runs: runs.map((r) => ({ id: r.id, promptId: r.promptId, input: r.input, output: r.output, tokens: r.tokens, costUsd: Number(r.costUsd), latencyMs: r.latencyMs, createdAt: r.createdAt })),
    };
  }

  /** New tenant version; it becomes the active one (older tenant versions are kept, inactive). */
  async createVersion(actor: TenantPrincipal, name: string, body: PromptVersionBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const existing = await db.aiPrompt.findMany({ where: { name, OR: [{ tenantId: actor.tenantId }, { tenantId: null }] }, orderBy: { version: 'desc' } });
    if (!existing.length) throw notFound(`Prompt "${name}"`);
    const base = existing[0]!;
    // Variables a template references but the feature never supplies would render literally.
    const known = new Set((base.variables as string[]) ?? []);
    const used = [...`${body.system}\n${body.template}`.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
    const unknown = [...new Set(used.filter((v) => !known.has(v)))];
    if (known.size && unknown.length) throw badRequest('UNKNOWN_VARIABLES', `Unknown variables: ${unknown.join(', ')}. Available: ${[...known].join(', ')}`);
    const version = Math.max(...existing.map((v) => v.version)) + 1;
    const created = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.aiPrompt.updateMany({ where: { tenantId: actor.tenantId, name }, data: { isActive: false } });
      return tx.aiPrompt.create({
        data: { tenantId: actor.tenantId, name, feature: base.feature, version, system: body.system, template: body.template, variables: base.variables as Prisma.InputJsonValue, modelKey: body.modelKey ?? base.modelKey, isActive: true, createdById: actor.userId ?? null },
      });
    });
    this.registry.invalidate(actor.tenantId, name);
    return { id: created.id, version: created.version };
  }

  /** scope "global" = drop the tenant override and fall back to the platform prompt. */
  async activate(actor: TenantPrincipal, name: string, version: number, scope: 'tenant' | 'global') {
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      if (scope === 'global') {
        await tx.aiPrompt.updateMany({ where: { tenantId: actor.tenantId, name }, data: { isActive: false } });
        return;
      }
      const target = await tx.aiPrompt.findFirst({ where: { tenantId: actor.tenantId, name, version } });
      if (!target) throw notFound(`Version ${version} of "${name}"`);
      await tx.aiPrompt.updateMany({ where: { tenantId: actor.tenantId, name }, data: { isActive: false } });
      await tx.aiPrompt.update({ where: { id: target.id }, data: { isActive: true } });
    });
    this.registry.invalidate(actor.tenantId, name);
    return this.get(actor.tenantId, name);
  }

  /** Playground for one prompt version with explicit variables; every run is kept for comparison. */
  async test(actor: TenantPrincipal, name: string, body: PromptTestBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const row = body.version
      ? await db.aiPrompt.findFirst({ where: { name, version: body.version, ...(body.scope === 'global' ? { tenantId: null } : body.scope === 'tenant' ? { tenantId: actor.tenantId } : { OR: [{ tenantId: actor.tenantId }, { tenantId: null }] }) }, orderBy: { tenantId: 'asc' } })
      : await db.aiPrompt.findUnique({ where: { id: (await this.registry.get(actor.tenantId, name)).id } });
    if (!row) throw notFound(`Prompt "${name}"`);
    const vars = body.variables;
    const system = renderTemplate(row.system ?? '', vars);
    const user = renderTemplate(row.template, vars);
    const missing = [...new Set([...`${system}\n${user}`.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))];
    const started = Date.now();
    const model = body.model ?? (row.modelKey && isModelKey(row.modelKey) ? (row.modelKey as ModelKey) : undefined);
    const res = await this.gateway.complete(
      { system, messages: [{ role: 'user', content: user }], ...(body.model ? { model: body.model, strictModel: true } : model ? { preferModel: model } : {}), maxTokens: 2_000 },
      { tenantId: actor.tenantId, userId: actor.userId, feature: row.feature, promptId: row.id, tags: { studio: 'prompt-test' } },
    );
    const latencyMs = Date.now() - started;
    const run = await this.prisma.rawForTenant({ tenantId: actor.tenantId }, (tx) =>
      tx.aiPromptRun.create({ data: { tenantId: actor.tenantId, promptId: row.id, input: { variables: vars, model: res.model } as Prisma.InputJsonValue, output: { text: res.text, status: res.status } as Prisma.InputJsonValue, tokens: res.usage.inputTokens + res.usage.outputTokens, costUsd: res.costMicroUsd / 1_000_000, latencyMs } }),
    );
    return { runId: run.id, version: row.version, rendered: { system, user }, unresolvedVariables: missing, output: res.text, latencyMs, usage: res.usage, ...meta(res) };
  }

  /** Same input against up to three models, side by side: quality, latency and cost in one view. */
  async playground(actor: TenantPrincipal, body: PlaygroundBody) {
    return Promise.all(
      body.models.map(async (model) => {
        const started = Date.now();
        try {
          const res = await this.gateway.complete(
            { model, strictModel: true, system: body.system, messages: [{ role: 'user', content: body.prompt }], maxTokens: body.maxTokens },
            { tenantId: actor.tenantId, userId: actor.userId, feature: 'CHAT', tags: { studio: 'playground' } },
          );
          return { model, ok: true, text: res.text, latencyMs: Date.now() - started, usage: res.usage, costUsd: res.costMicroUsd / 1_000_000, status: res.status, cacheHit: res.cacheHit };
        } catch (err) {
          // One model failing (plan tier, provider down) must not hide the others' results.
          return { model, ok: false, error: err instanceof ApiError || err instanceof Error ? err.message : 'failed', latencyMs: Date.now() - started };
        }
      }),
    );
  }
}
