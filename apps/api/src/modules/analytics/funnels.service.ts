import { Prisma } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { TenantPrincipal } from '../../common/auth/principal';
import { badRequest, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';

const MAX_FUNNELS = 20;

export const funnelStep = z.discriminatedUnion('kind', [
  /** A page view: an exact path, or a prefix ending in "*" ("/products/*"). */
  z.object({ kind: z.literal('page'), path: z.string().trim().max(300).regex(/^\/[^\s]*$/, 'A path like /pricing or /blog/*'), label: z.string().trim().max(60).optional() }).strict(),
  /** A tracked event: cta_click, form_submit, purchase… */
  z.object({ kind: z.literal('event'), name: z.string().trim().regex(/^[a-z0-9_.:-]{1,60}$/i), label: z.string().trim().max(60).optional() }).strict(),
]);
export type FunnelStep = z.infer<typeof funnelStep>;

export const funnelBody = z.object({
  name: z.string().trim().min(1).max(80),
  steps: z.array(funnelStep).min(2).max(6),
  /** "session": all steps in one visit; otherwise days the visitor has to finish after step 1. */
  window: z.union([z.literal('session'), z.number().int().min(1).max(90)]).default(7),
});
export type FunnelBody = z.infer<typeof funnelBody>;
export interface Funnel extends FunnelBody {
  id: string;
}

export interface FunnelResult {
  steps: { label: string; visitors: number; ofFirst: number; fromPrevious: number }[];
  /** Visitors who finished, as a share of those who started (0–1). */
  conversion: number;
}

/**
 * Funnels (Stage 12): how many visitors go through a sequence of pages and events, in order, and
 * where they drop off. One SQL statement per funnel — a CTE per step, each taking the first matching
 * event after the previous step's time for the same visitor (and session, if asked). Values are
 * bind parameters; only the CTE skeleton is built from code.
 */
@Injectable()
export class FunnelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, siteId: string, from: string, to: string) {
    const site = await this.sites.get(tenantId, siteId);
    const funnels = read(site.settings);
    return Promise.all(funnels.map(async (f) => ({ ...f, result: await this.compute(tenantId, siteId, f, from, to) })));
  }

  async create(actor: TenantPrincipal, siteId: string, body: FunnelBody) {
    const site = await this.sites.get(actor.tenantId, siteId);
    const funnels = read(site.settings);
    if (funnels.length >= MAX_FUNNELS) throw badRequest('TOO_MANY_FUNNELS', `A site keeps up to ${MAX_FUNNELS} funnels`);
    const f: Funnel = { id: globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12), ...body };
    await this.write(actor, siteId, site.settings, [...funnels, f]);
    await this.audit.record({ tenantId: actor.tenantId, action: 'funnel.created', entityType: 'Site', entityId: siteId, changes: { name: f.name, steps: f.steps.length } }, actor);
    return f;
  }

  async remove(actor: TenantPrincipal, siteId: string, id: string): Promise<void> {
    const site = await this.sites.get(actor.tenantId, siteId);
    const funnels = read(site.settings);
    if (!funnels.some((f) => f.id === id)) throw notFound('Funnel');
    await this.write(actor, siteId, site.settings, funnels.filter((f) => f.id !== id));
  }

  async compute(tenantId: string, siteId: string, f: Funnel, from: string, to: string): Promise<FunnelResult> {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
    const match = (s: FunnelStep, alias: string): Prisma.Sql => {
      const e = Prisma.raw(alias);
      if (s.kind === 'event') return Prisma.sql`${e}.event = ${s.name}`;
      if (s.path.endsWith('*')) {
        const prefix = s.path.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`);
        return Prisma.sql`${e}.event = 'pageview' AND (${e}.metadata->>'path') LIKE ${`${prefix}%`}`;
      }
      return Prisma.sql`${e}.event = 'pageview' AND (${e}.metadata->>'path') = ${s.path}`;
    };
    const ctes: Prisma.Sql[] = [];
    f.steps.forEach((s, i) => {
      const name = Prisma.raw(`s${i}`);
      if (i === 0) {
        ctes.push(Prisma.sql`${name} AS (SELECT e."visitorId" AS v, ${f.window === 'session' ? Prisma.sql`e."sessionId"` : Prisma.sql`''::text`} AS sid, min(e."createdAt") AS t, min(e."createdAt") AS t0 FROM analytics_events e WHERE e."siteId" = ${siteId} AND e."createdAt" >= ${start} AND e."createdAt" < ${end} AND ${match(s, 'e')} GROUP BY 1, 2)`);
        return;
      }
      const prev = Prisma.raw(`s${i - 1}`);
      const within = f.window === 'session' ? Prisma.sql`e."sessionId" = p.sid` : Prisma.sql`e."createdAt" <= p.t0 + make_interval(days => ${f.window}::int)`;
      ctes.push(Prisma.sql`${name} AS (SELECT p.v, p.sid, min(e."createdAt") AS t, min(p.t0) AS t0 FROM ${prev} p JOIN analytics_events e ON e."visitorId" = p.v AND e."siteId" = ${siteId} AND e."createdAt" > p.t AND e."createdAt" < ${end} AND ${within} WHERE ${match(s, 'e')} GROUP BY 1, 2)`);
    });
    const counts = Prisma.join(f.steps.map((_, i) => Prisma.sql`(SELECT count(DISTINCT v) FROM ${Prisma.raw(`s${i}`)})::int`), ', ');
    const rows = await this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<{ c: number[] }[]>(Prisma.sql`WITH ${Prisma.join(ctes, ', ')} SELECT ARRAY[${counts}] AS c`));
    const c = rows[0]?.c ?? f.steps.map(() => 0);
    const first = c[0] ?? 0;
    return {
      steps: f.steps.map((s, i) => ({ label: s.label || (s.kind === 'page' ? s.path : s.name), visitors: c[i] ?? 0, ofFirst: first ? (c[i] ?? 0) / first : 0, fromPrevious: i === 0 ? 1 : c[i - 1] ? (c[i] ?? 0) / c[i - 1]! : 0 })),
      conversion: first ? (c[c.length - 1] ?? 0) / first : 0,
    };
  }

  private async write(actor: TenantPrincipal, siteId: string, settings: unknown, funnels: Funnel[]): Promise<void> {
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data: { settings: { ...((settings as object) ?? {}), funnels } as unknown as Prisma.InputJsonValue } });
  }
}

function read(settings: unknown): Funnel[] {
  const raw = (settings as { funnels?: unknown } | null)?.funnels;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    const p = funnelBody.safeParse(f);
    return p.success && typeof (f as { id?: unknown }).id === 'string' ? [{ id: (f as { id: string }).id, ...p.data }] : [];
  });
}
