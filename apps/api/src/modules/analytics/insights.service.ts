import { createHash } from 'node:crypto';
import { AiGateway } from '@canon/ai-gateway';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { ctx, meta, parseJson } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { SitesService } from '../sites/sites.service';
import { dayString } from './rollup.service';
import { ReportsService, type Report } from './reports.service';

const CACHE_SEC = 6 * 3_600;
/** Below this, percentages are noise ("+300%" from 1 to 4 views). */
const MIN_VIEWS = 50;

export type Severity = 'positive' | 'warning' | 'info';
export type Action = 'ab_test' | 'personalize' | 'content' | 'seo' | 'none';

export interface Signal {
  kind: 'total_change' | 'page_change' | 'high_bounce' | 'no_conversions' | 'anomaly' | 'new_source';
  severity: Severity;
  title: string;
  detail: string;
  path?: string;
  value?: number;
  change?: number;
}

export interface Insights {
  from: string;
  to: string;
  summary: string;
  insights: { title: string; detail: string; severity: Severity; path?: string }[];
  recommendations: { title: string; detail: string; action: Action; path?: string }[];
  signals: Signal[];
  generatedBy: 'ai' | 'rules';
  ai?: ReturnType<typeof meta>;
}

const pct = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;

/**
 * Analytics → insights. The numbers are computed here, deterministically; the model only
 * explains and prioritises them. Its output may reference only paths present in the data, and
 * when no model is available the same signals become the insights verbatim — never a blank
 * panel, never an invented trend.
 */
@Injectable()
export class InsightsService {
  constructor(
    private readonly reports: ReportsService,
    private readonly sites: SitesService,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InsightsService.name);
  }

  async insights(p: TenantPrincipal, siteId: string, from: string, to: string, opts: { ai: boolean }): Promise<Insights> {
    const report = await this.reports.report(p.tenantId, siteId, from, to);
    const len = report.series.length;
    const prevTo = dayString(new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000));
    const prevFrom = dayString(new Date(Date.parse(`${from}T00:00:00Z`) - len * 86_400_000));
    const previous = await this.reports.report(p.tenantId, siteId, prevFrom, prevTo);
    const signals = computeSignals(report, previous);

    const key = `ins:${siteId}:${from}:${to}:${createHash('sha1').update(JSON.stringify(signals)).digest('hex')}`;
    if (opts.ai) {
      const cached = await this.redis.get(key).catch(() => null);
      if (cached) return JSON.parse(cached) as Insights;
    }
    const base: Insights = { from, to, signals, ...fromRules(report, signals), generatedBy: 'rules' };
    if (!opts.ai || !signals.length) return base;

    try {
      const site = await this.sites.get(p.tenantId, siteId);
      const prompt = await this.prompts.get(p.tenantId, 'analytics.insights');
      const data = {
        period: { from, to, days: len },
        totals: report.totals,
        changeVsPreviousPeriod: report.change,
        topPages: report.pages.slice(0, 10),
        topReferrers: report.dims.referrer.slice(0, 5),
        devices: report.dims.device,
        signals,
      };
      const { system, user } = this.prompts.render(prompt, { siteName: site.name, data: JSON.stringify(data) });
      const res = await this.gateway.complete({ system, messages: [{ role: 'user', content: user }], preferModel: prompt.modelKey, responseFormat: 'json', maxTokens: 1_200, cache: 'exact' }, ctx(p, 'SUMMARIZE', prompt.id));
      const out = parseJson<{ summary?: unknown; insights?: unknown; recommendations?: unknown }>(res.text);
      const paths = new Set(report.pages.map((x) => x.path));
      // A path the data doesn't contain is a hallucination: drop the reference, keep the advice.
      const cleanPath = (x: unknown) => (typeof x === 'string' && paths.has(x) ? x : undefined);
      const insights = (Array.isArray(out?.insights) ? out.insights : []).flatMap((i) => {
        const r = i as { title?: unknown; detail?: unknown; severity?: unknown; path?: unknown };
        return typeof r.title === 'string' && typeof r.detail === 'string' ? [{ title: r.title.slice(0, 120), detail: r.detail.slice(0, 500), severity: (['positive', 'warning', 'info'].includes(r.severity as string) ? r.severity : 'info') as Severity, path: cleanPath(r.path) }] : [];
      });
      const recommendations = (Array.isArray(out?.recommendations) ? out.recommendations : []).flatMap((i) => {
        const r = i as { title?: unknown; detail?: unknown; action?: unknown; path?: unknown };
        return typeof r.title === 'string' && typeof r.detail === 'string' ? [{ title: r.title.slice(0, 120), detail: r.detail.slice(0, 500), action: (['ab_test', 'personalize', 'content', 'seo', 'none'].includes(r.action as string) ? r.action : 'none') as Action, path: cleanPath(r.path) }] : [];
      });
      if (typeof out?.summary !== 'string' || !insights.length) return base;
      const result: Insights = { from, to, signals, summary: out.summary.slice(0, 600), insights: insights.slice(0, 8), recommendations: recommendations.slice(0, 6), generatedBy: 'ai', ai: meta(res) };
      await this.redis.set(key, JSON.stringify(result), 'EX', CACHE_SEC).catch(() => undefined);
      return result;
    } catch (err) {
      this.logger.debug({ err }, 'analytics.insights_ai_unavailable');
      return base;
    }
  }
}

export function computeSignals(cur: Report, prev: Report): Signal[] {
  const out: Signal[] = [];
  const t = cur.totals;
  if (t.views + cur.previous.views >= MIN_VIEWS) {
    for (const [k, label] of [['views', 'Page views'], ['visitors', 'Visitors'], ['conversionRate', 'Conversion rate'], ['bounceRate', 'Bounce rate']] as const) {
      const ch = cur.change[k];
      if (ch === null || Math.abs(ch) < 0.15) continue;
      const good = k === 'bounceRate' ? ch < 0 : ch > 0;
      out.push({ kind: 'total_change', severity: good ? 'positive' : 'warning', title: `${label} ${pct(ch)}`, detail: `${label} moved from ${cur.previous[k]} to ${t[k]} compared with the previous ${cur.series.length} days.`, value: t[k], change: ch });
    }
  }
  const prevPages = new Map(prev.pages.map((p) => [p.path, p]));
  const moves = cur.pages
    .map((p) => ({ p, before: prevPages.get(p.path)?.views ?? 0 }))
    .filter((x) => x.p.views + x.before >= MIN_VIEWS && x.before > 0)
    .map((x) => ({ ...x, ch: (x.p.views - x.before) / x.before }))
    .filter((x) => Math.abs(x.ch) >= 0.3)
    .sort((a, b) => Math.abs(b.ch) - Math.abs(a.ch))
    .slice(0, 3);
  for (const m of moves) out.push({ kind: 'page_change', severity: m.ch > 0 ? 'positive' : 'warning', path: m.p.path, title: `${m.p.title ?? m.p.path}: views ${pct(m.ch)}`, detail: `${m.before} → ${m.p.views} views.`, value: m.p.views, change: m.ch });
  for (const p of cur.pages.filter((x) => x.views >= 30 && x.bounceRate >= 0.7).slice(0, 3)) {
    out.push({ kind: 'high_bounce', severity: 'warning', path: p.path, title: `${p.title ?? p.path}: ${Math.round(p.bounceRate * 100)}% bounce`, detail: `${p.views} views, most visitors leave without a second page.`, value: p.bounceRate });
  }
  const totalConv = cur.totals.conversions;
  for (const p of cur.pages.filter((x) => x.views >= MIN_VIEWS && x.conversions === 0).slice(0, 2)) {
    if (totalConv > 0) out.push({ kind: 'no_conversions', severity: 'info', path: p.path, title: `${p.title ?? p.path} gets traffic but no conversions`, detail: `${p.views} views and 0 goal completions while the site converts elsewhere.`, value: p.views });
  }
  const views = cur.series.map((d) => d.views);
  if (views.length >= 7) {
    const mean = views.reduce((a, b) => a + b, 0) / views.length;
    const sd = Math.sqrt(views.reduce((a, b) => a + (b - mean) ** 2, 0) / views.length);
    cur.series.forEach((d) => {
      const z = sd ? (d.views - mean) / sd : 0;
      if (Math.abs(z) >= 2.5 && d.views >= 20) out.push({ kind: 'anomaly', severity: z > 0 ? 'info' : 'warning', title: `Unusual traffic on ${d.day}`, detail: `${d.views} views vs. an average of ${Math.round(mean)} (z=${z.toFixed(1)}).`, value: d.views });
    });
  }
  const prevRefs = new Set(prev.dims.referrer.map((r) => r.value));
  for (const r of cur.dims.referrer.filter((x) => !prevRefs.has(x.value) && x.value !== '(direct)' && x.views >= 20).slice(0, 2)) {
    out.push({ kind: 'new_source', severity: 'positive', title: `New traffic source: ${r.value}`, detail: `${r.views} views from ${r.value}, which sent nothing in the previous period.`, value: r.views });
  }
  return out;
}

/** The no-model path: signals as insights, each paired with the obvious next action. */
function fromRules(report: Report, signals: Signal[]): Pick<Insights, 'summary' | 'insights' | 'recommendations'> {
  const t = report.totals;
  const summary = report.totals.views
    ? `${t.views} views from ${t.visitors} visitors, ${t.conversions} conversions (${t.conversionRate.toFixed(2)} per visitor).${signals.length ? ` ${signals.length} notable change${signals.length === 1 ? '' : 's'}.` : ''}`
    : 'No traffic recorded in this period yet.';
  const recommendations = signals.flatMap((s): Insights['recommendations'] => {
    if (s.kind === 'high_bounce') return [{ title: `Test a stronger first screen on ${s.path}`, detail: 'Run an A/B test on the hero headline or call to action to keep visitors on the site.', action: 'ab_test', path: s.path }];
    if (s.kind === 'no_conversions') return [{ title: `Add a clear next step to ${s.path}`, detail: 'Add a call-to-action block that leads to a goal (signup, contact).', action: 'content', path: s.path }];
    if (s.kind === 'new_source') return [{ title: `Welcome visitors from ${s.title.replace('New traffic source: ', '')}`, detail: 'Create a segment for this referrer and personalize the hero for it.', action: 'personalize' }];
    return [];
  });
  return { summary, insights: signals.map((s) => ({ title: s.title, detail: s.detail, severity: s.severity, path: s.path })), recommendations: recommendations.slice(0, 6) };
}
