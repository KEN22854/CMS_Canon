import {
  auditPage,
  effectiveDescription,
  effectiveTitle,
  collectMediaIds,
  type PageContent,
  type SeoIssue,
} from '@canon/blocks';
import {
  REDIRECT_STATUSES,
  findRedirectLoop,
  normalizeRedirectPath,
  redirectIssue,
  type RedirectRule,
} from '@canon/edge';
import { Prisma, type Redirect } from '@canon/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  type OnModuleInit,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest, conflict, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { EventBus, Outbox, type StoredEvent } from '../../infrastructure/events/outbox';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';

const MAX_REDIRECTS_PER_SITE = 5_000;
const MAX_IMPORT_LINES = 2_000;

const redirectBody = z.object({
  fromPath: z.string().trim().min(1).max(500),
  toPath: z.string().trim().min(1).max(1000),
  statusCode: z
    .union(
      REDIRECT_STATUSES.map((s) => z.literal(s)) as unknown as [
        z.ZodLiteral<301>,
        z.ZodLiteral<302>,
        z.ZodLiteral<307>,
        z.ZodLiteral<308>,
      ],
    )
    .default(301),
  note: z.string().trim().max(200).optional(),
});
const updateBody = redirectBody.partial();
const importBody = z.object({ csv: z.string().max(500_000) });
type RedirectBody = z.infer<typeof redirectBody>;

/** Public path as visitors see it: non-default locales carry their prefix. */
const publicPath = (fullPath: string, locale: string, defaultLocale: string) =>
  locale === defaultLocale ? fullPath : `/${locale}${fullPath === '/' ? '' : fullPath}`;

/**
 * Redirects (Stage 9). Typed in by people, imported from CSV, or created automatically when a
 * published page moves (old path → new path, and old/* → new/* for the pages below it). A live
 * page always wins over a stale rule: publishing at a redirected path removes that rule. Every
 * change bumps the site's delivery version, so the renderer picks the rules up within seconds.
 */
@Injectable()
export class RedirectsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly outbox: Outbox,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.bus.on('PageMoved', (e) => this.onMoved(e));
    this.bus.on('PagePublished', (e) => this.onPublished(e));
  }

  async list(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma
      .forTenant({ tenantId })
      .redirect.findMany({ where: { tenantId, siteId }, orderBy: [{ fromPath: 'asc' }] });
    return rows.map(present);
  }

  async create(actor: TenantPrincipal, siteId: string, body: RedirectBody) {
    await this.sites.get(actor.tenantId, siteId);
    const rule = this.checked(body.fromPath, body.toPath);
    const existing = await this.rules(actor.tenantId, siteId);
    if (existing.length >= MAX_REDIRECTS_PER_SITE)
      throw badRequest('REDIRECT_LIMIT', `A site can have at most ${MAX_REDIRECTS_PER_SITE} redirects`);
    this.assertNoLoop([
      ...existing.filter((r) => r.from !== rule.from),
      { ...rule, status: body.statusCode },
    ]);
    try {
      const r = await this.prisma.rawForTenant(
        { tenantId: actor.tenantId, userId: actor.userId },
        async (tx) => {
          const created = await tx.redirect.create({
            data: {
              tenantId: actor.tenantId,
              siteId,
              fromPath: rule.from,
              toPath: rule.to,
              statusCode: body.statusCode,
              note: body.note ?? null,
              createdById: actor.userId,
            },
          });
          await this.changed(tx, actor.tenantId, siteId);
          return created;
        },
      );
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          action: 'redirect.created',
          entityType: 'Redirect',
          entityId: r.id,
          changes: { from: rule.from, to: rule.to, status: body.statusCode },
        },
        actor,
      );
      return present(r);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw conflict(`A redirect from ${rule.from} already exists`);
      throw err;
    }
  }

  async update(actor: TenantPrincipal, id: string, body: Partial<RedirectBody>) {
    const current = await this.get(actor.tenantId, id);
    const rule = this.checked(body.fromPath ?? current.fromPath, body.toPath ?? current.toPath);
    const status = body.statusCode ?? (current.statusCode as RedirectRule['status']);
    const others = (await this.rules(actor.tenantId, current.siteId)).filter(
      (r) => r.from !== current.fromPath,
    );
    this.assertNoLoop([...others, { ...rule, status }]);
    const r = await this.prisma
      .rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
        const updated = await tx.redirect.update({
          where: { id },
          data: {
            fromPath: rule.from,
            toPath: rule.to,
            statusCode: status,
            automatic: false,
            ...(body.note !== undefined ? { note: body.note } : {}),
          },
        });
        await this.changed(tx, actor.tenantId, current.siteId);
        return updated;
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          throw conflict(`A redirect from ${rule.from} already exists`);
        throw err;
      });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'redirect.updated',
        entityType: 'Redirect',
        entityId: id,
        changes: { from: rule.from, to: rule.to, status },
      },
      actor,
    );
    return present(r);
  }

  async remove(actor: TenantPrincipal, id: string): Promise<void> {
    const current = await this.get(actor.tenantId, id);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.redirect.delete({ where: { id } });
      await this.changed(tx, actor.tenantId, current.siteId);
    });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'redirect.deleted',
        entityType: 'Redirect',
        entityId: id,
        changes: { from: current.fromPath },
      },
      actor,
    );
  }

  /**
   * CSV "from,to[,status]" (a header row is skipped). Valid lines are upserted by source path;
   * invalid ones are reported by line number and nothing about them is stored.
   */
  async import(actor: TenantPrincipal, siteId: string, csv: string) {
    await this.sites.get(actor.tenantId, siteId);
    const lines = csv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > MAX_IMPORT_LINES)
      throw badRequest('IMPORT_TOO_LARGE', `At most ${MAX_IMPORT_LINES} lines per import`);
    const errors: { line: number; message: string }[] = [];
    const rules = new Map<string, RedirectRule>();
    lines.forEach((line, i) => {
      const [from = '', to = '', status = '301'] = line
        .split(/[,;\t]/)
        .map((c) => c.trim().replace(/^"|"$/g, ''));
      if (i === 0 && /^(from|source|old)/i.test(from)) return;
      const code = Number(status) as RedirectRule['status'];
      if (!(REDIRECT_STATUSES as readonly number[]).includes(code))
        return errors.push({ line: i + 1, message: `Unsupported status ${status}` });
      try {
        const r = this.checked(from, to);
        rules.set(r.from, { ...r, status: code });
      } catch (err) {
        errors.push({ line: i + 1, message: err instanceof Error ? err.message : 'Invalid line' });
      }
    });
    const existing = (await this.rules(actor.tenantId, siteId)).filter((r) => !rules.has(r.from));
    if (existing.length + rules.size > MAX_REDIRECTS_PER_SITE)
      throw badRequest('REDIRECT_LIMIT', `A site can have at most ${MAX_REDIRECTS_PER_SITE} redirects`);
    this.assertNoLoop([...existing, ...rules.values()]);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      for (const r of rules.values()) {
        await tx.redirect.upsert({
          where: { siteId_fromPath: { siteId, fromPath: r.from } },
          create: {
            tenantId: actor.tenantId,
            siteId,
            fromPath: r.from,
            toPath: r.to,
            statusCode: r.status,
            createdById: actor.userId,
          },
          update: { toPath: r.to, statusCode: r.status, automatic: false },
        });
      }
      if (rules.size) await this.changed(tx, actor.tenantId, siteId);
    });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'redirect.imported',
        entityType: 'Site',
        entityId: siteId,
        changes: { imported: rules.size, errors: errors.length },
      },
      actor,
    );
    return { imported: rules.size, errors };
  }

  /** Rules for the renderer (delivery runtime config). */
  async forDelivery(siteId: string): Promise<RedirectRule[]> {
    const rows = await this.system.redirect.findMany({
      where: { siteId },
      select: { fromPath: true, toPath: true, statusCode: true },
    });
    return rows.map((r) => ({
      from: r.fromPath,
      to: r.toPath,
      status: r.statusCode as RedirectRule['status'],
    }));
  }

  private async get(tenantId: string, id: string): Promise<Redirect> {
    const r = await this.prisma.forTenant({ tenantId }).redirect.findFirst({ where: { id, tenantId } });
    if (!r) throw notFound('Redirect');
    return r;
  }

  private async rules(tenantId: string, siteId: string): Promise<RedirectRule[]> {
    const rows = await this.prisma
      .forTenant({ tenantId })
      .redirect.findMany({
        where: { tenantId, siteId },
        select: { fromPath: true, toPath: true, statusCode: true },
      });
    return rows.map((r) => ({
      from: r.fromPath,
      to: r.toPath,
      status: r.statusCode as RedirectRule['status'],
    }));
  }

  private checked(fromRaw: string, toRaw: string): { from: string; to: string } {
    const prefix = fromRaw.trim().endsWith('/*');
    const from = prefix
      ? `${normalizeRedirectPath(fromRaw.trim().slice(0, -2))}/*`.replace('//*', '/*')
      : normalizeRedirectPath(fromRaw);
    const to = toRaw.trim();
    const issue = redirectIssue(from, to);
    if (issue) throw badRequest('INVALID_REDIRECT', issue);
    return { from, to };
  }

  private assertNoLoop(rules: RedirectRule[]) {
    const loop = findRedirectLoop(rules);
    if (loop) throw badRequest('REDIRECT_LOOP', `These redirects would loop: ${loop.join(' → ')}`);
  }

  private async changed(tx: Prisma.TransactionClient, tenantId: string, siteId: string) {
    await this.outbox.enqueue(tx, {
      tenantId,
      aggregateType: 'Site',
      aggregateId: siteId,
      type: 'RedirectsChanged',
      payload: { siteId },
    });
  }

  /** A published page moved: keep its old address (and the pages below it) working. */
  private async onMoved(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; locale: string; fromPath: string; toPath: string };
    if (!p.fromPath || !p.toPath || p.fromPath === p.toPath || p.fromPath === '/') return;
    const site = await this.system.site.findFirst({
      where: { id: p.siteId, deletedAt: null },
      select: { defaultLocale: true, tenantId: true },
    });
    if (!site) return;
    const from = publicPath(p.fromPath, p.locale, site.defaultLocale);
    const to = publicPath(p.toPath, p.locale, site.defaultLocale);
    const pairs = [
      { from, to },
      { from: `${from}/*`, to: `${to === '/' ? '' : to}/*` },
    ];
    await this.system.$transaction(async (tx) => {
      for (const r of pairs) {
        if (redirectIssue(r.from, r.to)) continue;
        // A rule someone typed in wins over an automatic one.
        const existing = await tx.redirect.findUnique({
          where: { siteId_fromPath: { siteId: p.siteId, fromPath: r.from } },
        });
        if (existing && !existing.automatic) continue;
        await tx.redirect.upsert({
          where: { siteId_fromPath: { siteId: p.siteId, fromPath: r.from } },
          create: {
            tenantId: e.tenantId,
            siteId: p.siteId,
            fromPath: r.from,
            toPath: r.to,
            statusCode: 301,
            automatic: true,
            note: 'Page moved',
          },
          update: { toPath: r.to },
        });
      }
      // Older automatic rules that pointed at the old address now point at the new one (no chains).
      await tx.redirect.updateMany({
        where: { siteId: p.siteId, automatic: true, toPath: from },
        data: { toPath: to },
      });
      await tx.redirect.deleteMany({ where: { siteId: p.siteId, fromPath: to } });
      await this.changed(tx, e.tenantId, p.siteId);
    });
  }

  /** A page is live at a path: a redirect from that path would hide it. */
  private async onPublished(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; locale: string; fullPath: string };
    const site = await this.system.site.findFirst({
      where: { id: p.siteId },
      select: { defaultLocale: true },
    });
    if (!site) return;
    await this.system.$transaction(async (tx) => {
      const res = await tx.redirect.deleteMany({
        where: { siteId: p.siteId, fromPath: publicPath(p.fullPath, p.locale, site.defaultLocale) },
      });
      if (res.count) await this.changed(tx, e.tenantId, p.siteId);
    });
  }
}

/**
 * The SEO audit of a site: every page (its current draft, so problems can be fixed before
 * publishing) checked by `auditPage` with the site-wide context — duplicate titles and
 * descriptions, which internal links resolve (published pages and redirect sources), alt texts
 * of library media.
 */
@Injectable()
export class SeoAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
  ) {}

  async audit(tenantId: string, siteId: string) {
    const site = await this.sites.get(tenantId, siteId);
    const db = this.prisma.forTenant({ tenantId });
    const [pages, redirects] = await Promise.all([
      db.page.findMany({
        where: { tenantId, siteId, deletedAt: null },
        select: {
          id: true,
          title: true,
          description: true,
          seo: true,
          content: true,
          fullPath: true,
          locale: true,
          status: true,
          publishedVersion: true,
        },
        orderBy: [{ fullPath: 'asc' }, { locale: 'asc' }],
        take: 2_000,
      }),
      db.redirect.findMany({ where: { tenantId, siteId }, select: { fromPath: true } }),
    ]);
    const path = (p: { fullPath: string; locale: string }) =>
      publicPath(p.fullPath, p.locale, site.defaultLocale);
    const knownPaths = new Set([
      ...pages.filter((p) => p.publishedVersion !== null).map(path),
      ...redirects.filter((r) => !r.fromPath.endsWith('/*')).map((r) => r.fromPath),
    ]);
    const knownPrefixes = redirects
      .filter((r) => r.fromPath.endsWith('/*'))
      .map((r) => r.fromPath.slice(0, -2));
    const inputs = pages.map((p) => ({
      id: p.id,
      title: p.title,
      path: path(p),
      description: p.description,
      seo: (p.seo ?? {}) as Record<string, never>,
      content: p.content as unknown as PageContent,
    }));
    const count = (values: string[]) =>
      values.reduce((m, v) => (v ? m.set(v, (m.get(v) ?? 0) + 1) : m), new Map<string, number>());
    // Duplicates are about what search engines see: only indexable pages count.
    const indexable = inputs.filter(
      (p, i) => pages[i]!.publishedVersion !== null && !(p.seo as { noindex?: boolean }).noindex,
    );
    const titleCounts = count(indexable.map((p) => effectiveTitle(p).toLowerCase()));
    const descriptionCounts = count(indexable.map((p) => effectiveDescription(p).toLowerCase()));
    const mediaIds = [...new Set(inputs.flatMap((p) => collectMediaIds(p.content)))];
    const media = mediaIds.length
      ? await db.media.findMany({ where: { id: { in: mediaIds }, siteId }, select: { id: true, alt: true } })
      : [];
    const ctx = {
      knownPaths,
      knownPrefixes,
      titleCounts,
      descriptionCounts,
      mediaAlt: Object.fromEntries(media.map((m) => [m.id, m.alt])),
      defaultOgImage: Boolean((site.seoDefaults as { ogImageMediaId?: string } | null)?.ogImageMediaId),
    };

    const results = inputs.map((p, i) => {
      const row = pages[i]!;
      const r = auditPage(p, ctx);
      return {
        id: p.id,
        title: p.title,
        path: p.path,
        locale: row.locale,
        status: row.status,
        published: row.publishedVersion !== null,
        score: r.score,
        words: r.words,
        issues: r.issues,
      };
    });
    const totals = { error: 0, warning: 0, info: 0 } as Record<SeoIssue['severity'], number>;
    for (const r of results) for (const i of r.issues) totals[i.severity] += 1;
    const live = results.filter((r) => r.published);
    return {
      score: live.length ? Math.round(live.reduce((s, r) => s + r.score, 0) / live.length) : null,
      totals,
      pages: results.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)),
      checkedAt: new Date().toISOString(),
    };
  }
}

function present(r: Redirect) {
  return {
    id: r.id,
    siteId: r.siteId,
    fromPath: r.fromPath,
    toPath: r.toPath,
    statusCode: r.statusCode,
    automatic: r.automatic,
    note: r.note,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

@ApiTags('seo')
@ApiBearerAuth()
@Controller({ version: '1' })
export class SeoController {
  constructor(
    private readonly redirects: RedirectsService,
    private readonly seo: SeoAuditService,
  ) {}

  @Get('sites/:siteId/seo/audit')
  @RequirePermission('read', 'Page')
  @ApiOperation({
    summary:
      'SEO audit of every page: score and issues (titles, descriptions, headings, alt texts, links, indexing, content)',
  })
  audit(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.seo.audit(p.tenantId, siteId);
  }

  @Get('sites/:siteId/redirects')
  @RequirePermission('read', 'Page')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.redirects.list(p.tenantId, siteId);
  }

  @Post('sites/:siteId/redirects')
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Create a redirect (exact path or prefix "/old/*" → path, "/new/*" or URL)' })
  create(
    @Param('siteId') siteId: string,
    @Body(new ZodBody(redirectBody)) body: RedirectBody,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.redirects.create(p, siteId, body);
  }

  @Post('sites/:siteId/redirects/import')
  @HttpCode(200)
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Import redirects from CSV "from,to[,status]"; returns per-line errors' })
  import(
    @Param('siteId') siteId: string,
    @Body(new ZodBody(importBody)) body: { csv: string },
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.redirects.import(p, siteId, body.csv);
  }

  @Patch('redirects/:id')
  @RequirePermission('update', 'Site')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(updateBody)) body: Partial<RedirectBody>,
    @TenantScope() p: TenantPrincipal,
  ) {
    return this.redirects.update(p, id, body);
  }

  @Delete('redirects/:id')
  @HttpCode(204)
  @RequirePermission('update', 'Site')
  async remove(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.redirects.remove(p, id);
  }
}

@Module({
  imports: [SitesModule],
  controllers: [SeoController],
  providers: [RedirectsService, SeoAuditService],
  exports: [RedirectsService],
})
export class SeoModule {}
