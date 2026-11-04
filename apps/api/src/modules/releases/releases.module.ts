import { Prisma, type SiteRelease } from '@canon/db';
import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';

type Tx = Prisma.TransactionClient;
interface PageRef {
  pageId: string;
  version: number;
  title: string;
  path: string;
}
interface ComponentRef {
  componentId: string;
  version: number | null;
  tree: Prisma.JsonValue;
  name: string;
}
interface EntryRef {
  entryId: string;
  version: number;
}

/** More than this many live entries can't be captured in one release (keeps rows bounded). */
const MAX_ENTRIES = 20_000;

const createBody = z.object({ note: z.string().trim().max(200).optional() });

/**
 * Site releases (Stage 13). A release records what is live — page and entry version pointers and
 * component published trees — so a bad publish can be undone for the whole site at once. Rolling
 * back is one transaction: a "before rollback" release first (so the rollback itself can be undone),
 * then every pointer back; pages and entries published after the release go offline. URLs are not
 * versioned: a page keeps its current path. One SiteRolledBack event refreshes delivery caches.
 */
@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).siteRelease.findMany({ where: { tenantId, siteId }, orderBy: { number: 'desc' }, take: 100, include: undefined });
    return rows.map(summary);
  }

  async create(actor: TenantPrincipal, siteId: string, note?: string) {
    await this.sites.get(actor.tenantId, siteId);
    const r = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) => this.capture(tx, actor, siteId, note ?? null, false));
    await this.audit.record({ tenantId: actor.tenantId, action: 'release.created', entityType: 'Site', entityId: siteId, changes: { number: r.number } }, actor);
    return summary(r);
  }

  /** What a rollback to this release would change, compared with what is live now. */
  async detail(tenantId: string, siteId: string, id: string) {
    const r = await this.find(tenantId, siteId, id);
    const now = await this.live(this.prisma.forTenant({ tenantId }) as unknown as Tx, siteId);
    const pages = r.pages as unknown as PageRef[];
    const comps = r.components as unknown as ComponentRef[];
    const entries = r.entries as unknown as EntryRef[];
    const thenPage = new Map(pages.map((p) => [p.pageId, p]));
    const nowPage = new Map(now.pages.map((p) => [p.pageId, p]));
    const existing = new Set((await this.prisma.forTenant({ tenantId }).page.findMany({ where: { siteId, id: { in: pages.map((p) => p.pageId) }, deletedAt: null }, select: { id: true } })).map((p) => p.id));
    const thenEntry = new Map(entries.map((e) => [e.entryId, e.version]));
    return {
      ...summary(r),
      changes: {
        restored: pages.filter((p) => existing.has(p.pageId) && nowPage.get(p.pageId)?.version !== p.version).map((p) => ({ title: p.title, path: p.path, from: nowPage.get(p.pageId)?.version ?? null, to: p.version })),
        unpublished: now.pages.filter((p) => !thenPage.has(p.pageId)).map((p) => ({ title: p.title, path: p.path })),
        missing: pages.filter((p) => !existing.has(p.pageId)).map((p) => ({ title: p.title, path: p.path })),
        components: comps.filter((c) => now.components.find((x) => x.componentId === c.componentId)?.version !== c.version).length + now.components.filter((c) => !comps.some((x) => x.componentId === c.componentId)).length,
        entries: entries.filter((e) => now.entries.find((x) => x.entryId === e.entryId)?.version !== e.version).length + now.entries.filter((e) => !thenEntry.has(e.entryId)).length,
      },
    };
  }

  async rollback(actor: TenantPrincipal, siteId: string, id: string) {
    const r = await this.find(actor.tenantId, siteId, id);
    const result = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      const before = await this.capture(tx, actor, siteId, `Before rollback to release ${r.number}`, true);
      const pages = r.pages as unknown as PageRef[];
      const versions = new Map(pages.map((p) => [p.pageId, p.version]));
      const live = await tx.page.findMany({ where: { siteId, deletedAt: null }, select: { id: true, publishedVersion: true } });
      let restored = 0;
      let unpublished = 0;
      let skipped = 0;
      for (const p of live) {
        const v = versions.get(p.id);
        if (v === undefined) {
          if (p.publishedVersion !== null) {
            await tx.page.update({ where: { id: p.id }, data: { publishedVersion: null, status: 'DRAFT' } });
            unpublished += 1;
          }
          continue;
        }
        if (p.publishedVersion === v) continue;
        // The snapshot must still exist (versions are never deleted, but be safe).
        if (!(await tx.pageVersion.findUnique({ where: { pageId_version: { pageId: p.id, version: v } }, select: { pageId: true } }))) {
          skipped += 1;
          continue;
        }
        await tx.page.update({ where: { id: p.id }, data: { publishedVersion: v, status: 'PUBLISHED' } });
        restored += 1;
      }
      skipped += pages.filter((p) => !live.some((x) => x.id === p.pageId)).length;

      const comps = r.components as unknown as ComponentRef[];
      const liveComps = await tx.siteComponent.findMany({ where: { siteId, deletedAt: null }, select: { id: true, publishedVersion: true } });
      for (const c of liveComps) {
        const then = comps.find((x) => x.componentId === c.id);
        if (!then) {
          if (c.publishedVersion !== null) await tx.siteComponent.update({ where: { id: c.id }, data: { publishedTree: Prisma.DbNull, publishedVersion: null } });
        } else if (then.version !== c.publishedVersion) {
          await tx.siteComponent.update({ where: { id: c.id }, data: { publishedTree: then.tree === null ? Prisma.DbNull : (then.tree as Prisma.InputJsonValue), publishedVersion: then.version } });
        }
      }

      const entries = new Map((r.entries as unknown as EntryRef[]).map((e) => [e.entryId, e.version]));
      const liveEntries = await tx.entry.findMany({ where: { collection: { siteId }, deletedAt: null }, select: { id: true, publishedVersion: true } });
      for (const e of liveEntries) {
        const v = entries.get(e.id);
        if (v === undefined) {
          if (e.publishedVersion !== null) await tx.entry.update({ where: { id: e.id }, data: { publishedVersion: null, status: 'DRAFT' } });
        } else if (v !== e.publishedVersion && (await tx.entryVersion.findUnique({ where: { entryId_version: { entryId: e.id, version: v } }, select: { entryId: true } }))) {
          await tx.entry.update({ where: { id: e.id }, data: { publishedVersion: v, status: 'PUBLISHED' } });
        }
      }

      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'Site', aggregateId: siteId, type: 'SiteRolledBack', payload: { siteId, releaseId: r.id, number: r.number, backupNumber: before.number } });
      return { restored, unpublished, skipped, backup: summary(before) };
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'release.rolled_back', entityType: 'Site', entityId: siteId, changes: { to: r.number, ...result, backup: result.backup.number } }, actor);
    return result;
  }

  private async find(tenantId: string, siteId: string, id: string): Promise<SiteRelease> {
    await this.sites.get(tenantId, siteId);
    const r = await this.prisma.forTenant({ tenantId }).siteRelease.findFirst({ where: { id, siteId, tenantId } });
    if (!r) throw notFound('Release');
    return r;
  }

  private async live(tx: Tx, siteId: string) {
    const [pages, components, entries] = await Promise.all([
      tx.page.findMany({ where: { siteId, deletedAt: null, publishedVersion: { not: null } }, select: { id: true, publishedVersion: true, title: true, fullPath: true, locale: true } }),
      tx.siteComponent.findMany({ where: { siteId, deletedAt: null, publishedVersion: { not: null } }, select: { id: true, publishedVersion: true, publishedTree: true, name: true } }),
      tx.entry.findMany({ where: { collection: { siteId }, deletedAt: null, publishedVersion: { not: null } }, select: { id: true, publishedVersion: true }, take: MAX_ENTRIES + 1 }),
    ]);
    if (entries.length > MAX_ENTRIES) throw badRequest('TOO_LARGE', `Releases capture up to ${MAX_ENTRIES} live entries`);
    return {
      pages: pages.map((p): PageRef => ({ pageId: p.id, version: p.publishedVersion!, title: p.title, path: p.locale === 'en' ? p.fullPath : `${p.fullPath} (${p.locale})` })),
      components: components.map((c): ComponentRef => ({ componentId: c.id, version: c.publishedVersion, tree: c.publishedTree, name: c.name })),
      entries: entries.map((e): EntryRef => ({ entryId: e.id, version: e.publishedVersion! })),
    };
  }

  private async capture(tx: Tx, actor: TenantPrincipal, siteId: string, note: string | null, automatic: boolean): Promise<SiteRelease> {
    const now = await this.live(tx, siteId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`releases:${siteId}`}))`;
    const last = await tx.siteRelease.aggregate({ where: { siteId }, _max: { number: true } });
    return tx.siteRelease.create({
      data: { tenantId: actor.tenantId, siteId, number: (last._max.number ?? 0) + 1, note, automatic, pages: now.pages as unknown as Prisma.InputJsonValue, components: now.components as unknown as Prisma.InputJsonValue, entries: now.entries as unknown as Prisma.InputJsonValue, createdById: actor.userId ?? null },
    });
  }
}

function summary(r: SiteRelease) {
  const pages = r.pages as unknown as PageRef[];
  return { id: r.id, number: r.number, note: r.note, automatic: r.automatic, pageCount: pages.length, componentCount: (r.components as unknown[]).length, entryCount: (r.entries as unknown[]).length, pages: pages.map((p) => ({ title: p.title, path: p.path })).slice(0, 200), createdAt: r.createdAt };
}

@ApiTags('releases')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/releases', version: '1' })
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get()
  @RequirePermission('read', 'Site')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.releases.list(p.tenantId, siteId);
  }

  @Post()
  @RequirePermission('publish', 'Page')
  @ApiOperation({ summary: 'Record what is live now (page/entry versions, component trees) as a numbered release' })
  create(@Param('siteId') siteId: string, @Body(new ZodBody(createBody)) body: { note?: string }, @TenantScope() p: TenantPrincipal) {
    return this.releases.create(p, siteId, body.note);
  }

  @Get(':id')
  @RequirePermission('read', 'Site')
  @ApiOperation({ summary: 'A release and what rolling back to it would change' })
  detail(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.releases.detail(p.tenantId, siteId, id);
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Put the whole site back to this release (a "before rollback" release is recorded first)' })
  rollback(@Param('siteId') siteId: string, @Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.releases.rollback(p, siteId, id);
  }
}

@Module({
  imports: [SitesModule],
  controllers: [ReleasesController],
  providers: [ReleasesService],
})
export class ReleasesModule {}
