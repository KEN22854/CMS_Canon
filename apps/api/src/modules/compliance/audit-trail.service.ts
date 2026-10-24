import { createHash } from 'node:crypto';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';

export const auditQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  action: z.string().max(80).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  userId: z.string().max(40).optional(),
  actorType: z.enum(['user', 'api-key', 'agent', 'system']).optional(),
  aiInvolved: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuery>;

interface AuditRow {
  id: string;
  userId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  aiInvolved: boolean;
  createdAt: Date;
}

const GENESIS = '0'.repeat(64);
const SEAL_QUEUE = 'audit-seal';
const SEAL_EVERY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/** Key-order independent JSON so a row hashes the same however Postgres returns jsonb keys. */
function stable(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The audit trail: filtered reads and exports for compliance, plus tamper evidence. Rows are
 * append-only for the request role already; on top of that, every finished day is sealed with
 * SHA-256(previous digest + that day's rows). Verification recomputes the chain, so an edited,
 * inserted or deleted row — even by someone with database access — shows up as a broken day.
 */
@Injectable()
export class AuditTrailService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly queues: Queues,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditTrailService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.COMPLIANCE_JOBS === 'off') return;
    this.queues.worker(SEAL_QUEUE, async () => {
      await this.ensurePartitions();
      await this.sealDays();
    }, 1);
    await this.queues.queue(SEAL_QUEUE).upsertJobScheduler('audit-seal', { every: SEAL_EVERY_MS }, { name: 'seal', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async list(tenantId: string, q: AuditQuery) {
    const db = this.prisma.forTenant({ tenantId });
    const [cursorAt, cursorId] = q.cursor ? (Buffer.from(q.cursor, 'base64url').toString().split('|') as [string, string]) : [];
    const rows = await db.auditLog.findMany({
      where: {
        tenantId,
        ...(q.action ? { action: { startsWith: q.action } } : {}),
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId ? { entityId: q.entityId } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.actorType ? { actorType: q.actorType } : {}),
        ...(q.aiInvolved ? { aiInvolved: q.aiInvolved === 'true' } : {}),
        createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + DAY_MS) } : {}) },
        ...(cursorAt && cursorId ? { OR: [{ createdAt: { lt: new Date(cursorAt) } }, { createdAt: new Date(cursorAt), id: { lt: cursorId } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const userIds = [...new Set(page.map((r) => r.userId).filter((u): u is string => Boolean(u)))];
    const users = userIds.length ? await this.system.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const last = page.at(-1);
    return {
      items: page.map((r) => ({ ...r, user: r.userId ? (byId.get(r.userId) ?? null) : null })),
      nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
  }

  /** Streams every matching row (oldest first) as CSV or JSON Lines, page by page. */
  async *export(tenantId: string, q: AuditQuery, format: 'csv' | 'jsonl'): AsyncGenerator<string> {
    if (format === 'csv') yield 'createdAt,id,actorType,userId,userEmail,action,entityType,entityId,aiInvolved,ipAddress,changes\n';
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list(tenantId, { ...q, cursor, limit: 200 });
      for (const r of page.items) {
        if (format === 'jsonl') yield `${JSON.stringify(r)}\n`;
        else yield `${[r.createdAt.toISOString(), r.id, r.actorType, r.userId ?? '', r.user?.email ?? '', r.action, r.entityType, r.entityId, r.aiInvolved, r.ipAddress ?? '', JSON.stringify(r.changes)].map(csvCell).join(',')}\n`;
      }
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  private async rowsOf(tenantId: string, day: string): Promise<AuditRow[]> {
    return this.system.$queryRaw<AuditRow[]>`
      SELECT id, "userId", "actorType", action, "entityType", "entityId", changes, "ipAddress", "userAgent", "aiInvolved", "createdAt"
      FROM audit_logs WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${day}::date AND "createdAt" < ${day}::date + 1
      ORDER BY "createdAt", id`;
  }

  private digest(prevHash: string, rows: AuditRow[]): string {
    const h = createHash('sha256').update(prevHash);
    for (const r of rows) h.update('\n').update(stable(r));
    return h.digest('hex');
  }

  /**
   * Seals every finished day (before `until`, default today UTC) that has rows and no digest yet,
   * per tenant in day order so each digest chains to the one before it.
   */
  async sealDays(until = new Date()): Promise<{ sealed: number }> {
    const cutoff = dayStr(until);
    const pending = await this.system.$queryRaw<{ tenantId: string; day: Date }[]>`
      SELECT DISTINCT a."tenantId", a."createdAt"::date AS day FROM audit_logs a
      WHERE a."createdAt" < ${cutoff}::date
        AND NOT EXISTS (SELECT 1 FROM audit_digests d WHERE d."tenantId" = a."tenantId" AND d.day = a."createdAt"::date)
      ORDER BY a."tenantId", day`;
    let sealed = 0;
    for (const { tenantId, day } of pending) {
      const d = dayStr(day);
      const prev = await this.system.auditDigest.findFirst({ where: { tenantId, day: { lt: day } }, orderBy: { day: 'desc' } });
      const rows = await this.rowsOf(tenantId, d);
      await this.system.auditDigest.create({ data: { tenantId, day, count: rows.length, prevHash: prev?.hash ?? GENESIS, hash: this.digest(prev?.hash ?? GENESIS, rows) } }).catch(() => undefined);
      sealed++;
    }
    if (sealed) this.logger.info({ sealed }, 'audit.sealed');
    return { sealed };
  }

  /** Keeps three months of partitions ahead for the partitioned tables (idempotent, cheap). */
  async ensurePartitions(): Promise<void> {
    for (const table of ['"audit_logs"', '"analytics_events"']) await this.system.$executeRawUnsafe(`SELECT canon_ensure_monthly_partitions('${table}'::regclass, 3)`);
  }

  /** Recomputes the chain over a range: every sealed day must match, and link to its predecessor. */
  async verify(tenantId: string, from?: string, to?: string) {
    const digests = await this.system.auditDigest.findMany({
      where: { tenantId, day: { ...(from ? { gte: new Date(`${from}T00:00:00Z`) } : {}), ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}) } },
      orderBy: { day: 'asc' },
    });
    const days: { day: string; count: number; status: 'ok' | 'modified' | 'broken_chain' }[] = [];
    let prevHash: string | null = null;
    if (digests[0]) {
      const before = await this.system.auditDigest.findFirst({ where: { tenantId, day: { lt: digests[0].day } }, orderBy: { day: 'desc' } });
      prevHash = before?.hash ?? GENESIS;
    }
    for (const d of digests) {
      const rows = await this.rowsOf(tenantId, dayStr(d.day));
      const status = d.prevHash !== prevHash ? 'broken_chain' : this.digest(d.prevHash, rows) !== d.hash || rows.length !== d.count ? 'modified' : 'ok';
      days.push({ day: dayStr(d.day), count: rows.length, status });
      prevHash = d.hash;
    }
    return { ok: days.every((d) => d.status === 'ok'), sealedDays: days.length, days: days.filter((d) => d.status !== 'ok').concat(days.length <= 31 ? days.filter((d) => d.status === 'ok') : []).sort((a, b) => a.day.localeCompare(b.day)) };
  }
}

function csvCell(v: unknown): string {
  let s = String(v);
  // Spreadsheet formula injection: a leading = + - @ would execute in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
