import { subject } from '@casl/ability';
import { emptyPageContent } from '@canon/blocks';
import { Prisma, type Page, type Site } from '@canon/db';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, forbidden, notFound, quotaExceeded } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { BlockRegistry } from '../../infrastructure/blocks/block-registry';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { TenantsService } from '../tenancy/tenants.service';
import type { CreatePageBody, ListPagesQuery, ReorderBody, ScheduleBody, UpdatePageBody } from './pages.dto';
import { ScheduleStore } from './schedule-store';

/** First path segments the renderer owns; a page there would be unreachable. */
const RESERVED = new Set(['api', '_next', 's', 'sitemap.xml', 'robots.txt', 'favicon.ico', 'preview']);
const PREVIEW_AUDIENCE = 'canon-preview';

type Tx = Prisma.TransactionClient;

export interface PreviewClaims {
  pid: string;
  tid: string;
  sid: string;
  typ: 'preview';
}

@Injectable()
export class PagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly tenants: TenantsService,
    private readonly blocks: BlockRegistry,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly scheduler: ScheduleStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────────

  async list(tenantId: string, siteId: string, q: ListPagesQuery) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).page.findMany({
      where: {
        tenantId,
        siteId,
        deletedAt: null,
        ...(q.status ? { status: q.status } : {}),
        ...(q.locale ? { locale: q.locale } : {}),
        ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { fullPath: { contains: q.q.toLowerCase() } }] } : {}),
      },
      orderBy: [{ fullPath: 'asc' }, { locale: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: summarySelect,
    });
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(presentSummary);
    return { items, nextCursor: hasMore ? items.at(-1)?.id : null };
  }

  async get(tenantId: string, siteId: string, pageId: string): Promise<Page> {
    const page = await this.prisma.forTenant({ tenantId }).page.findFirst({ where: { id: pageId, siteId, tenantId, deletedAt: null } });
    if (!page) throw notFound('Page');
    return page;
  }

  async detail(tenantId: string, siteId: string, pageId: string) {
    const page = await this.get(tenantId, siteId, pageId);
    const db = this.prisma.forTenant({ tenantId });
    const [translations, schedule] = await Promise.all([
      page.translationGroupId
        ? db.page.findMany({ where: { translationGroupId: page.translationGroupId, deletedAt: null, NOT: { id: page.id } }, select: { id: true, locale: true, fullPath: true, status: true } })
        : Promise.resolve([]),
      db.scheduledPublish.findFirst({ where: { tenantId, entityType: 'PAGE', entityId: page.id, status: 'PENDING' }, orderBy: { scheduledAt: 'asc' } }),
    ]);
    return {
      ...presentSummary(page),
      description: page.description,
      content: page.content,
      seo: page.seo,
      translations,
      schedule: schedule ? { id: schedule.id, at: schedule.scheduledAt, action: schedule.action } : null,
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  async create(actor: TenantPrincipal, siteId: string, body: CreatePageBody) {
    const site = await this.sites.get(actor.tenantId, siteId);
    const locale = body.locale ?? site.defaultLocale;
    if (!site.locales.includes(locale)) throw badRequest('INVALID_LOCALE', `Site does not have locale "${locale}"`);
    await this.assertPageLimit(actor.tenantId);
    const parent = body.parentId ? await this.get(actor.tenantId, siteId, body.parentId) : null;
    if (parent && parent.locale !== locale) throw badRequest('INVALID_PARENT', 'Parent page must have the same locale');
    const fullPath = this.buildPath(site, parent, body.slug);
    const content = body.content === undefined ? emptyPageContent() : await this.blocks.validate(body.content);

    const page = await this.write(actor, async (tx) => {
      const created = await tx.page.create({
        data: {
          tenantId: actor.tenantId,
          siteId,
          parentId: parent?.id ?? null,
          slug: body.slug,
          fullPath,
          title: body.title,
          description: body.description ?? null,
          locale,
          content: content as unknown as Prisma.InputJsonValue,
          seo: body.seo ?? {},
          position: 1_000_000, // end of siblings; normalised on first reorder
          createdById: actor.userId ?? null,
          updatedById: actor.userId ?? null,
        },
      });
      await this.outbox.enqueue(tx, pageEvent(created, 'PageChanged', { version: 1 }));
      return created;
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.created', entityType: 'Page', entityId: page.id, changes: { fullPath, locale } }, actor);
    return this.detail(actor.tenantId, siteId, page.id);
  }

  async update(actor: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string, body: UpdatePageBody) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    this.assertCan(ability, 'update', page);
    const site = await this.sites.get(actor.tenantId, siteId);

    const data: Prisma.PageUncheckedUpdateManyInput = { version: { increment: 1 }, updatedById: actor.userId ?? null };
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.seo !== undefined) data.seo = { ...(page.seo as object), ...body.seo };
    if (body.content !== undefined) data.content = (await this.blocks.validate(body.content)) as unknown as Prisma.InputJsonValue;

    const moving = (body.slug !== undefined && body.slug !== page.slug) || (body.parentId !== undefined && body.parentId !== page.parentId);
    let newPath = page.fullPath;
    let parentId = page.parentId;
    if (moving) {
      parentId = body.parentId === undefined ? page.parentId : body.parentId;
      const parent = parentId ? await this.get(actor.tenantId, siteId, parentId) : null;
      if (parent) assertNotDescendant(page, parent);
      if (parent && parent.locale !== page.locale) throw badRequest('INVALID_PARENT', 'Parent page must have the same locale');
      newPath = this.buildPath(site, parent, body.slug ?? page.slug);
      data.slug = body.slug ?? page.slug;
      data.fullPath = newPath;
    }

    await this.write(actor, async (tx) => {
      // Compare-and-swap on version: a stale editor tab can never overwrite newer work.
      const res = await tx.page.updateMany({ where: { id: pageId, version: body.expectedVersion, deletedAt: null }, data: { ...data, ...(moving ? { parentId } : {}) } });
      if (res.count === 0) {
        throw new ApiError('VERSION_CONFLICT', 'The page was changed by someone else — reload to get the latest version', 409, { currentVersion: page.version });
      }
      // Draft text changed: Canon re-scans it for fact mentions (consumers subscribe by type).
      if (body.content !== undefined) await this.outbox.enqueue(tx, pageEvent(page, 'PageChanged', { version: page.version + 1 }));
      if (moving && newPath !== page.fullPath) {
        await this.rewriteDescendantPaths(tx, page, newPath);
        if (page.publishedVersion) {
          await this.outbox.enqueue(tx, pageEvent(page, 'PageMoved', { fromPath: page.fullPath, toPath: newPath }));
        }
      }
    });
    return this.detail(actor.tenantId, siteId, pageId);
  }

  async remove(actor: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string): Promise<void> {
    const page = await this.get(actor.tenantId, siteId, pageId);
    this.assertCan(ability, 'delete', page);
    if (page.fullPath === '/' && page.locale === (await this.sites.get(actor.tenantId, siteId)).defaultLocale) {
      throw conflict('The home page of the default locale cannot be deleted');
    }
    await this.write(actor, async (tx) => {
      const prefix = `${page.fullPath}/`;
      const now = new Date();
      // Children go with their parent; their URLs would otherwise dangle under a deleted path.
      const affected = await tx.page.findMany({
        where: { siteId, locale: page.locale, deletedAt: null, OR: [{ id: page.id }, { fullPath: { startsWith: prefix } }] },
        select: { id: true, fullPath: true, publishedVersion: true, tenantId: true, siteId: true, locale: true },
      });
      await tx.page.updateMany({ where: { id: { in: affected.map((a) => a.id) } }, data: { deletedAt: now, status: 'ARCHIVED', publishedVersion: null } });
      for (const a of affected.filter((x) => x.publishedVersion)) await this.outbox.enqueue(tx, pageEvent(a, 'PageUnpublished', { reason: 'deleted' }));
    });
    await this.scheduler.cancelForPage(actor.tenantId, pageId);
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.deleted', entityType: 'Page', entityId: pageId, changes: { fullPath: page.fullPath } }, actor);
  }

  async duplicate(actor: TenantPrincipal, siteId: string, pageId: string) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    await this.assertPageLimit(actor.tenantId);
    const base = page.slug || 'home';
    for (let i = 1; i <= 20; i++) {
      const slug = `${base}-copy${i === 1 ? '' : `-${i}`}`.slice(0, 80);
      try {
        const copy = await this.create(actor, siteId, { title: `${page.title} (copy)`, slug, parentId: page.parentId, locale: page.locale, description: page.description ?? undefined, content: page.content, seo: page.seo as CreatePageBody['seo'] });
        return copy;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'PATH_TAKEN')) throw err;
      }
    }
    throw conflict('Could not find a free slug for the copy');
  }

  /** Snapshot the draft into a version and make it live — the only way content reaches the site. */
  async publish(actor: TenantPrincipal, ability: AppAbility | null, siteId: string, pageId: string, comment?: string) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    if (ability) this.assertCan(ability, 'publish', page);
    await this.write(actor, async (tx) => {
      await this.snapshot(tx, page, actor, comment ?? 'Published');
      await tx.page.update({ where: { id: pageId }, data: { status: 'PUBLISHED', publishedVersion: page.version, publishedAt: new Date(), scheduledAt: null } });
      await tx.site.update({ where: { id: siteId }, data: { isPublished: true, publishedAt: new Date() } });
      await this.outbox.enqueue(tx, pageEvent(page, 'PagePublished', { version: page.version }));
    });
    await this.scheduler.cancelForPage(actor.tenantId, pageId, 'PUBLISH');
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.published', entityType: 'Page', entityId: pageId, changes: { version: page.version } }, actor);
    return this.detail(actor.tenantId, siteId, pageId);
  }

  async unpublish(actor: TenantPrincipal, ability: AppAbility | null, siteId: string, pageId: string) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    if (ability) this.assertCan(ability, 'publish', page);
    if (!page.publishedVersion) return this.detail(actor.tenantId, siteId, pageId);
    await this.write(actor, async (tx) => {
      await tx.page.update({ where: { id: pageId }, data: { status: 'DRAFT', publishedVersion: null } });
      await this.outbox.enqueue(tx, pageEvent(page, 'PageUnpublished', { reason: 'unpublished' }));
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.unpublished', entityType: 'Page', entityId: pageId }, actor);
    return this.detail(actor.tenantId, siteId, pageId);
  }

  async schedule(actor: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string, body: ScheduleBody) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    this.assertCan(ability, 'publish', page);
    await this.scheduler.cancelForPage(actor.tenantId, pageId);
    const row = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).scheduledPublish.create({
      data: { tenantId: actor.tenantId, entityType: 'PAGE', entityId: pageId, action: body.action, scheduledAt: body.at, timezone: body.timezone },
    });
    if (body.action === 'PUBLISH' && page.status !== 'PUBLISHED') {
      await this.prisma.forTenant({ tenantId: actor.tenantId }).page.update({ where: { id: pageId }, data: { status: 'SCHEDULED', scheduledAt: body.at } });
    }
    await this.scheduler.enqueue(row.id, body.at);
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.scheduled', entityType: 'Page', entityId: pageId, changes: { at: body.at.toISOString(), action: body.action } }, actor);
    return this.detail(actor.tenantId, siteId, pageId);
  }

  async cancelSchedule(actor: TenantPrincipal, siteId: string, pageId: string) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    await this.scheduler.cancelForPage(actor.tenantId, pageId);
    if (page.status === 'SCHEDULED') {
      await this.prisma.forTenant({ tenantId: actor.tenantId }).page.update({ where: { id: pageId }, data: { status: 'DRAFT', scheduledAt: null } });
    }
    return this.detail(actor.tenantId, siteId, pageId);
  }

  // ── versions ───────────────────────────────────────────────────────────────

  async versions(tenantId: string, siteId: string, pageId: string) {
    const page = await this.get(tenantId, siteId, pageId);
    const rows = await this.prisma.forTenant({ tenantId }).pageVersion.findMany({
      where: { pageId },
      orderBy: { version: 'desc' },
      take: 100,
      select: { version: true, comment: true, createdAt: true, createdBy: { select: { id: true, name: true } } },
    });
    return rows.map((v) => ({ ...v, isPublished: v.version === page.publishedVersion }));
  }

  async version(tenantId: string, siteId: string, pageId: string, version: number) {
    await this.get(tenantId, siteId, pageId);
    const v = await this.prisma.forTenant({ tenantId }).pageVersion.findUnique({ where: { pageId_version: { pageId, version } } });
    if (!v) throw notFound('Version');
    return { version: v.version, content: v.content, seo: v.seo, comment: v.comment, createdAt: v.createdAt };
  }

  /** Explicit "save point" so editors can name versions without publishing. */
  async checkpoint(actor: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string, comment?: string) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    this.assertCan(ability, 'update', page);
    await this.write(actor, (tx) => this.snapshot(tx, page, actor, comment ?? 'Saved version'));
    return this.versions(actor.tenantId, siteId, pageId);
  }

  /** Restore copies an old snapshot into the *draft*; going live still needs a publish. */
  async restore(actor: TenantPrincipal, ability: AppAbility, siteId: string, pageId: string, version: number) {
    const page = await this.get(actor.tenantId, siteId, pageId);
    this.assertCan(ability, 'update', page);
    const v = await this.version(actor.tenantId, siteId, pageId, version);
    await this.write(actor, async (tx) => {
      await this.snapshot(tx, page, actor, `Before restoring v${version}`);
      await tx.page.update({ where: { id: pageId }, data: { content: v.content as Prisma.InputJsonValue, seo: v.seo as Prisma.InputJsonValue, version: { increment: 1 }, updatedById: actor.userId ?? null } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'page.version_restored', entityType: 'Page', entityId: pageId, changes: { version } }, actor);
    return this.detail(actor.tenantId, siteId, pageId);
  }

  // ── tree ───────────────────────────────────────────────────────────────────

  async reorder(actor: TenantPrincipal, ability: AppAbility, siteId: string, body: ReorderBody) {
    const site = await this.sites.get(actor.tenantId, siteId);
    const ids = body.items.map((i) => i.id);
    const pages = await this.prisma.forTenant({ tenantId: actor.tenantId }).page.findMany({ where: { id: { in: ids }, siteId, deletedAt: null } });
    if (pages.length !== ids.length) throw notFound('Page');
    const byId = new Map(pages.map((p) => [p.id, p]));
    for (const p of pages) this.assertCan(ability, 'update', p);

    await this.write(actor, async (tx) => {
      for (const item of body.items) {
        const page = byId.get(item.id)!;
        if (item.parentId === page.parentId) {
          await tx.page.update({ where: { id: page.id }, data: { position: item.position } });
          continue;
        }
        const parent = item.parentId ? (byId.get(item.parentId) ?? (await this.get(actor.tenantId, siteId, item.parentId))) : null;
        if (parent) assertNotDescendant(page, parent);
        const newPath = this.buildPath(site, parent, page.slug);
        await tx.page.update({ where: { id: page.id }, data: { position: item.position, parentId: parent?.id ?? null, fullPath: newPath, version: { increment: 1 } } });
        await this.rewriteDescendantPaths(tx, page, newPath);
        if (page.publishedVersion) await this.outbox.enqueue(tx, pageEvent(page, 'PageMoved', { fromPath: page.fullPath, toPath: newPath }));
      }
    });
    return this.list(actor.tenantId, siteId, { limit: 200 });
  }

  // ── preview ────────────────────────────────────────────────────────────────

  async previewUrl(tenantId: string, siteId: string, pageId: string) {
    const page = await this.get(tenantId, siteId, pageId);
    const site = await this.sites.get(tenantId, siteId);
    const token = await this.jwt.signAsync({ pid: page.id, tid: tenantId, sid: siteId, typ: 'preview' } satisfies PreviewClaims, {
      audience: PREVIEW_AUDIENCE,
      expiresIn: this.config.PREVIEW_TTL_SEC,
    });
    const host = site.domain ?? site.internalDomain;
    const base = this.config.NODE_ENV === 'production' ? `https://${host}` : `http://${host}:${this.config.WEB_PUBLIC_PORT}`;
    return { url: `${base}/api/draft?token=${encodeURIComponent(token)}`, expiresInSec: this.config.PREVIEW_TTL_SEC };
  }

  async verifyPreview(token: string): Promise<PreviewClaims> {
    try {
      const claims = await this.jwt.verifyAsync<PreviewClaims>(token, { audience: PREVIEW_AUDIENCE, algorithms: ['HS256'] });
      if (claims.typ !== 'preview') throw new Error('wrong type');
      return claims;
    } catch {
      throw new ApiError('INVALID_PREVIEW_TOKEN', 'Preview link is invalid or expired', 401);
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private write<T>(actor: TenantPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, fn).catch((err: unknown) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError('PATH_TAKEN', 'Another page already uses this URL in this locale', 409);
      }
      throw err;
    });
  }

  private async snapshot(tx: Tx, page: Page, actor: TenantPrincipal, comment: string): Promise<void> {
    await tx.pageVersion.upsert({
      where: { pageId_version: { pageId: page.id, version: page.version } },
      create: { tenantId: page.tenantId, pageId: page.id, version: page.version, content: page.content as Prisma.InputJsonValue, seo: page.seo as Prisma.InputJsonValue, comment, createdById: actor.userId ?? null },
      // Same draft version snapshotted twice (e.g. checkpoint then publish): keep the content, refresh the label.
      update: { comment },
    });
  }

  private buildPath(site: Site, parent: Page | null, slug: string): string {
    if (!slug) {
      if (parent) throw badRequest('INVALID_SLUG', 'Only the home page may have an empty slug');
      return '/';
    }
    if (!parent && (RESERVED.has(slug) || (site.locales.includes(slug) && slug !== site.defaultLocale))) {
      throw badRequest('RESERVED_SLUG', `"${slug}" is reserved (routing or a locale prefix)`);
    }
    const base = parent && parent.fullPath !== '/' ? parent.fullPath : '';
    return `${base}/${slug}`;
  }

  private async rewriteDescendantPaths(tx: Tx, page: Pick<Page, 'siteId' | 'locale' | 'fullPath'>, newPath: string): Promise<void> {
    if (page.fullPath === '/') return;
    const oldPrefix = `${page.fullPath}/`;
    await tx.$executeRaw`
      UPDATE pages SET "fullPath" = ${newPath} || substring("fullPath" from ${page.fullPath.length + 1}::int), version = version + 1
      WHERE "siteId" = ${page.siteId} AND locale = ${page.locale} AND "deletedAt" IS NULL AND starts_with("fullPath", ${oldPrefix})`;
  }

  private async assertPageLimit(tenantId: string): Promise<void> {
    const tenant = await this.tenants.get(tenantId);
    const limit = this.tenants.limits(tenant).pages;
    if (limit === null) return;
    const count = await this.prisma.forTenant({ tenantId }).page.count({ where: { tenantId, deletedAt: null } });
    if (count >= limit) throw quotaExceeded(`Your ${tenant.plan} plan allows ${limit} pages`, { resource: 'pages', limit });
  }

  private assertCan(ability: AppAbility, action: 'update' | 'delete' | 'publish', page: Page): void {
    if (!ability.can(action, subject('Page', { tenantId: page.tenantId, createdById: page.createdById }))) {
      throw forbidden(action === 'publish' ? 'Your role cannot publish pages' : `Not allowed to ${action} this page`);
    }
  }
}

const summarySelect = {
  id: true,
  siteId: true,
  parentId: true,
  title: true,
  slug: true,
  fullPath: true,
  locale: true,
  status: true,
  version: true,
  publishedVersion: true,
  position: true,
  translationGroupId: true,
  aiGenerated: true,
  qualityScore: true,
  publishedAt: true,
  scheduledAt: true,
  updatedAt: true,
  createdAt: true,
  createdById: true,
  updatedById: true,
  tenantId: true,
} satisfies Prisma.PageSelect;

function presentSummary(p: Prisma.PageGetPayload<{ select: typeof summarySelect }>) {
  return {
    id: p.id,
    siteId: p.siteId,
    parentId: p.parentId,
    title: p.title,
    slug: p.slug,
    fullPath: p.fullPath,
    locale: p.locale,
    status: p.status,
    version: p.version,
    publishedVersion: p.publishedVersion,
    /** Draft moved past the live snapshot: the editor shows "unpublished changes". */
    hasUnpublishedChanges: p.publishedVersion !== null && p.publishedVersion !== p.version,
    position: p.position,
    translationGroupId: p.translationGroupId,
    aiGenerated: p.aiGenerated,
    qualityScore: p.qualityScore,
    publishedAt: p.publishedAt,
    scheduledAt: p.scheduledAt,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    createdById: p.createdById,
    updatedById: p.updatedById,
  };
}

function assertNotDescendant(page: Page, candidateParent: Page): void {
  const isSelfOrBelow = candidateParent.id === page.id || (page.fullPath !== '/' && candidateParent.fullPath.startsWith(`${page.fullPath}/`));
  if (isSelfOrBelow || page.fullPath === '/') throw badRequest('INVALID_PARENT', 'A page cannot be moved under itself or its descendants');
}

function pageEvent(p: Pick<Page, 'tenantId' | 'siteId' | 'id' | 'locale' | 'fullPath'>, type: string, extra: Prisma.InputJsonObject) {
  return { tenantId: p.tenantId, aggregateType: 'Page', aggregateId: p.id, type, payload: { siteId: p.siteId, pageId: p.id, locale: p.locale, fullPath: p.fullPath, ...extra } };
}
