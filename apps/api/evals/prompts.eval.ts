/* eslint-disable no-console -- prints the evaluation report */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AiGateway, isModelKey, type ModelKey } from '@canon/ai-gateway';
import { NestFactory } from '@nestjs/core';
import { expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { SystemPrismaService } from '../src/infrastructure/prisma/prisma.service';
import { PromptRegistry } from '../src/modules/intelligence/infrastructure/prompt-registry';
import { SUITES } from './suites';

/**
 * pnpm --filter @canon/api eval
 *   EVAL_MODELS=anthropic/claude-haiku-5-5,openai/gpt-4o-mini   models to compare (default: each prompt's model)
 *   EVAL_PROMPT=canon.propagate_fact                             one suite only
 *   EVAL_RUNS=3                                                  repeats per case (models are not deterministic)
 *   EVAL_MIN=0.8                                                 required pass rate per model
 *   EVAL_TENANT=acme                                             whose quotas and ledger the calls use
 *
 * Every call goes through the real gateway, so quotas, guardrails and the cost ledger apply. A
 * report lands in evals/reports/. Without any provider key the run is skipped, not failed.
 */
const env = process.env;
const hasProvider = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GOOGLE_API_KEY || env.OLLAMA_BASE_URL);
for (const flag of ['SCHEDULER', 'ENRICHMENT', 'KNOWLEDGE', 'CANON_EXTRACT', 'CANON_PROPAGATE', 'ANALYTICS_FLUSH', 'ANALYTICS_JOBS', 'WEBHOOKS', 'BILLING_JOBS', 'COMPLIANCE_JOBS']) env[flag] ??= 'off';

interface Row {
  model: string;
  prompt: string;
  case: string;
  pass: boolean;
  issues: string[];
  latencyMs: number;
  costUsd: number;
  error?: string;
}

it.skipIf(!hasProvider)('prompts meet their checks on the selected models', async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const gateway = app.get(AiGateway);
  const prompts = app.get(PromptRegistry);
  const tenant = await app.get(SystemPrismaService).tenant.findFirst({ where: { slug: env.EVAL_TENANT ?? 'acme', deletedAt: null }, select: { id: true, slug: true } });
  if (!tenant) throw new Error('Tenant not found: seed the demo tenant or set EVAL_TENANT');

  const runs = Number(env.EVAL_RUNS ?? 1);
  const min = Number(env.EVAL_MIN ?? 0.8);
  const requested = (env.EVAL_MODELS ?? '').split(',').filter(Boolean);
  for (const m of requested) if (!isModelKey(m)) throw new Error(`Not a model key: ${m}`);

  const rows: Row[] = [];
  try {
    for (const suite of SUITES.filter((s) => !env.EVAL_PROMPT || s.prompt === env.EVAL_PROMPT)) {
      const p = await prompts.get(tenant.id, suite.prompt);
      const models = (requested.length ? requested : [p.modelKey ?? env.AI_DEFAULT_MODEL]) as ModelKey[];
      for (const model of models) {
        for (const c of suite.cases) {
          for (let r = 0; r < runs; r++) {
            const { system, user } = prompts.render(p, c.vars);
            try {
              const res = await gateway.complete(
                { model, strictModel: true, system, messages: [{ role: 'user', content: user }], responseFormat: suite.json ? 'json' : 'text', maxTokens: suite.maxTokens, cache: 'none' },
                { tenantId: tenant.id, feature: p.feature, promptId: p.id, tags: { eval: suite.prompt } },
              );
              let json: unknown = null;
              if (suite.json) {
                try {
                  json = JSON.parse(res.text.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '').trim());
                } catch {
                  json = null;
                }
              }
              const issues = c.check(res.text, json);
              rows.push({ model, prompt: suite.prompt, case: c.name, pass: issues.length === 0, issues, latencyMs: res.latencyMs, costUsd: res.costMicroUsd / 1e6 });
            } catch (err) {
              const message = (err as Error).message;
              if (c.acceptBlocked && /guardrail/i.test(message)) rows.push({ model, prompt: suite.prompt, case: c.name, pass: true, issues: [], latencyMs: 0, costUsd: 0 });
              else rows.push({ model, prompt: suite.prompt, case: c.name, pass: false, issues: [], latencyMs: 0, costUsd: 0, error: message.slice(0, 160) });
            }
          }
        }
      }
    }
  } finally {
    await app.close();
  }

  console.log('\n| model | prompt | case | result | ms | $ |\n|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.model} | ${r.prompt} | ${r.case} | ${r.error ? `error: ${r.error}` : r.pass ? 'pass' : `FAIL: ${r.issues.join('; ')}`} | ${r.latencyMs} | ${r.costUsd.toFixed(5)} |`);
  const byModel = new Map<string, Row[]>();
  for (const r of rows) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  const summary = [...byModel].map(([model, list]) => {
    const ran = list.filter((x) => !x.error);
    const passed = ran.filter((x) => x.pass).length;
    const lat = ran.map((x) => x.latencyMs).sort((a, b) => a - b);
    return { model, ran: ran.length, passed, rate: ran.length ? passed / ran.length : 0, costUsd: list.reduce((n, x) => n + x.costUsd, 0), p50Ms: lat[Math.floor(lat.length / 2)] ?? null };
  });
  console.log('\n| model | pass rate | total $ | p50 ms |\n|---|---|---|---|');
  for (const s of summary) console.log(`| ${s.model} | ${(s.rate * 100).toFixed(0)}% (${s.passed}/${s.ran}) | ${s.costUsd.toFixed(4)} | ${s.p50Ms ?? '-'} |`);

  const dir = join(__dirname, 'reports');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ at: new Date().toISOString(), tenant: tenant.slug, min, summary, rows }, null, 2));

  // Models that never answered (bad key, outage) are reported, not graded.
  for (const s of summary.filter((x) => x.ran > 0)) expect(s.rate, `${s.model} pass rate`).toBeGreaterThanOrEqual(min);
});
