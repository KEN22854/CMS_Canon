import { htmlToRichText, newId, richTextToPlain, type BlockNode } from '@canon/blocks';
import { slugify } from '@canon/fields';
import { Controller, HttpCode, Injectable, Module, Param, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AppAbility } from '../../common/auth/abilities';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, forbidden } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CollectionsModule } from '../collections/collections.module';
import { CollectionsService } from '../collections/collections.service';
import { EntriesService } from '../collections/entries.service';
import { PagesModule } from '../pages/pages.module';
import { PagesService } from '../pages/pages.service';
import { SeoModule, RedirectsService } from '../seo/seo.module';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';
import { parseWxr, type WxrItem } from './wxr';

const MAX_BYTES = 20 * 1024 * 1024;
const BASE_PATH = '/blog';

export interface MigrationReport {
  dryRun: boolean;
  source: { title: string; link: string };
  posts: { total: number; published: number; drafts: number };
  pages: { total: number; published: number; drafts: number };
  categories: string[];
  authors: string[];
  images: number;
  skipped: Record<string, number>;
  redirects: { from: string; to: string }[];
  created?: { entries: number; pages: number; redirects: number; collection: string };
  warnings: string[];
  errors: { item: string; message: string }[];
}

const isLive = (i: WxrItem) => i.status === 'publish';
const importable = (i: WxrItem) => i.status !== 'trash' && i.status !== 'auto-draft';

/** The path an item had on the old site ("/2024/05/rye-bread/" → "/2024/05/rye-bread"). */
function oldPath(link: string): string | null {
  try {
    const p = new URL(link).pathname.replace(/\/+$/, '').toLowerCase();
    return p && p !== '/' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Migration center (Stage 17): a WordPress export becomes a Canon site — posts into a Blog
 * collection with entry pages at /blog/<slug> (template included), pages into pages (hierarchy
 * kept), and a 301 from every old address to the new one so search rankings and links survive.
 * Everything goes through the normal services (validation, permissions, events). A dry run
 * reports what would happen without changing anything.
 */
@Injectable()
export class MigrationService {
  constructor(
    private readonly sites: SitesService,
    private readonly collections: CollectionsService,
    private readonly entries: EntriesService,
    private readonly pages: PagesService,
    private readonly redirects: RedirectsService,
    private readonly audit: AuditService,
  ) {}

  async wordpress(actor: TenantPrincipal, ability: AppAbility, siteId: string, file: Buffer, dryRun: boolean): Promise<MigrationReport> {
    await this.sites.get(actor.tenantId, siteId);
    let site;
    try {
      site = parseWxr(file.toString('utf8'));
    } catch (err) {
      throw badRequest('INVALID_EXPORT', err instanceof Error ? err.message : 'Not a WordPress export');
    }
    const items = site.items.filter(importable);
    const posts = items.filter((i) => i.type === 'post');
    const pages = items.filter((i) => i.type === 'page');
    const converted = new Map(items.map((i) => [i, htmlToRichText(i.content)]));
    const postSlug = new Map(posts.map((p) => [p, slugify(p.slug || p.title || 'post').slice(0, 80) || 'post']));
    const report: MigrationReport = {
      dryRun,
      source: { title: site.title, link: site.link },
      posts: { total: posts.length, published: posts.filter(isLive).length, drafts: posts.filter((p) => !isLive(p)).length },
      pages: { total: pages.length, published: pages.filter(isLive).length, drafts: pages.filter((p) => !isLive(p)).length },
      categories: [...new Set(posts.flatMap((p) => p.categories))].slice(0, 100),
      authors: [...new Set(items.map((i) => i.author).filter(Boolean))],
      images: [...converted.values()].reduce((n, c) => n + c.images.length, 0),
      skipped: { ...site.skipped, ...(site.items.length - items.length ? { trash: site.items.length - items.length } : {}) },
      redirects: [],
      warnings: [],
      errors: [],
    };
    if (report.images) report.warnings.push(`${report.images} images are linked in the content; upload them to Media and place them again (images from the old site are not copied).`);
    const empty = items.filter((i) => converted.get(i)!.textLength === 0).length;
    if (empty) report.warnings.push(`${empty} items have no text.`);
    for (const p of posts.filter(isLive)) {
      const from = oldPath(p.link);
      const to = `${BASE_PATH}/${postSlug.get(p)}`;
      if (from && from !== to) report.redirects.push({ from, to });
    }
    if (dryRun) {
      // A page's new path follows its parents, as the import creates them.
      const byId = new Map(pages.map((p) => [p.id, p]));
      const pathOf = (p: WxrItem, depth = 0): string => {
        const own = slugify(p.slug || p.title || 'page').slice(0, 80) || 'page';
        const parent = p.parentId ? byId.get(p.parentId) : undefined;
        return parent && depth < 10 ? `${pathOf(parent, depth + 1)}/${own}` : `/${own}`;
      };
      for (const p of pages.filter(isLive)) {
        const from = oldPath(p.link);
        if (from) report.redirects.push({ from, to: pathOf(p) });
      }
      report.redirects = report.redirects.filter((r) => r.from !== r.to).slice(0, 2_000);
      return report;
    }

    if (!ability.can('create', 'Collection') || !ability.can('create', 'Page') || !ability.can('publish', 'Page')) throw forbidden('Importing a site needs a role that can create collections and publish pages');
    const created = { entries: 0, pages: 0, redirects: 0, collection: '' };
    const redirects: { from: string; to: string }[] = [];

    // Posts → the Blog collection (with entry pages, unless the address is taken).
    if (posts.length) {
      const existing = await this.collections.list(actor.tenantId, siteId);
      const slug = existing.some((c) => c.slug === 'blog') ? (existing.some((c) => c.slug === 'wordpress-posts') ? `wordpress-posts-${Date.now() % 100000}` : 'wordpress-posts') : 'blog';
      const col = await this.collections.create(actor, siteId, {
        name: slug === 'blog' ? 'Blog' : 'WordPress posts',
        slug,
        description: `Imported from ${site.title || site.link || 'WordPress'}`,
        isSingleton: false,
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true, unique: false, helpText: '', multiple: false, integer: false, ai: true, max: 300 },
          { name: 'excerpt', label: 'Excerpt', type: 'textarea', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: true, max: 1000 },
          { name: 'body', label: 'Body', type: 'richtext', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: true },
          ...(report.categories.length ? [{ name: 'category', label: 'Category', type: 'select' as const, options: report.categories, required: false, unique: false, helpText: '', multiple: false, integer: false, ai: false }] : []),
          { name: 'author', label: 'Author', type: 'text', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: false, max: 200 },
          { name: 'publishedOn', label: 'Published on', type: 'date', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: false },
          { name: 'sourceUrl', label: 'Original URL', type: 'url', required: false, unique: false, helpText: '', multiple: false, integer: false, ai: false },
        ],
        settings: { titleField: 'title' },
      });
      created.collection = col.slug;
      const routeTaken = existing.some((c) => c.settings.route?.basePath === BASE_PATH);
      if (!routeTaken) {
        const tpl = await this.pages.create(actor, siteId, { title: `${col.name}: entry template`, slug: `${col.slug}-template`, content: postTemplate() });
        await this.pages.publish(actor, ability, siteId, tpl.id, 'Imported template');
        await this.collections.update(actor, siteId, col.id, { settings: { titleField: 'title', route: { basePath: BASE_PATH, templatePageId: tpl.id } }, force: false });
      } else report.warnings.push(`${BASE_PATH} already serves another collection: imported posts have no pages of their own until you set an address.`);

      for (const p of posts) {
        try {
          const doc = converted.get(p)!.doc;
          const excerpt = (richTextToPlain(htmlToRichText(p.excerpt).doc) || richTextToPlain(doc)).slice(0, 300);
          const data: Record<string, unknown> = { title: (p.title || 'Untitled').slice(0, 300), excerpt, body: doc, author: p.author.slice(0, 200), sourceUrl: /^https?:\/\//.test(p.link) ? p.link.slice(0, 2000) : undefined, publishedOn: p.date?.slice(0, 10) };
          if (p.categories[0] && report.categories.includes(p.categories[0])) data.category = p.categories[0];
          const e = await this.createEntry(actor, siteId, col.id, data, postSlug.get(p)!, p.tags);
          created.entries += 1;
          if (isLive(p)) {
            await this.entries.publish(actor, ability, siteId, col.id, e.id, 'Imported from WordPress');
            const from = oldPath(p.link);
            if (!routeTaken && from && from !== `${BASE_PATH}/${e.slug}`) redirects.push({ from, to: `${BASE_PATH}/${e.slug}` });
          }
        } catch (err) {
          report.errors.push({ item: p.title || p.slug, message: err instanceof Error ? err.message : 'Failed' });
        }
      }
    }

    // Pages → pages, parents before children.
    const byWpId = new Map<number, string>();
    const ordered = [...pages].sort((a, b) => (a.parentId === 0 ? 0 : 1) - (b.parentId === 0 ? 0 : 1));
    for (const p of ordered) {
      try {
        const parentId = p.parentId ? (byWpId.get(p.parentId) ?? null) : null;
        const page = await this.createPage(actor, siteId, { title: (p.title || 'Untitled').slice(0, 200), slug: slugify(p.slug || p.title || 'page').slice(0, 80) || 'page', parentId, content: pageContent(p.title, converted.get(p)!.doc) });
        byWpId.set(p.id, page.id);
        created.pages += 1;
        if (isLive(p)) {
          await this.pages.publish(actor, ability, siteId, page.id, 'Imported from WordPress');
          const from = oldPath(p.link);
          if (from && from !== page.fullPath) redirects.push({ from, to: page.fullPath });
        }
      } catch (err) {
        report.errors.push({ item: p.title || p.slug, message: err instanceof Error ? err.message : 'Failed' });
      }
    }

    // Old addresses → new ones (301), skipping what can't be a rule (taken, loops, limits).
    for (const r of redirects) {
      try {
        await this.redirects.create(actor, siteId, { fromPath: r.from, toPath: r.to, statusCode: 301 });
        created.redirects += 1;
        report.redirects.push(r);
      } catch {
        // A rule for that address exists already, or it would loop: the existing behaviour wins.
      }
    }
    report.created = created;
    report.errors = report.errors.slice(0, 50);
    await this.audit.record({ tenantId: actor.tenantId, action: 'migration.wordpress', entityType: 'Site', entityId: siteId, changes: { ...created, errors: report.errors.length } }, actor);
    return report;
  }

  private async createEntry(actor: TenantPrincipal, siteId: string, cid: string, data: Record<string, unknown>, slug: string, tags: string[]) {
    for (let i = 1; i <= 20; i++) {
      try {
        return await this.entries.create(actor, siteId, cid, { data, slug: i === 1 ? slug : `${slug.slice(0, 74)}-${i}`, tags: tags.slice(0, 30).map((t) => t.slice(0, 40)) }, { source: 'import', skipEnrichment: true });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'SLUG_TAKEN')) throw err;
      }
    }
    throw new Error('No free slug');
  }

  private async createPage(actor: TenantPrincipal, siteId: string, body: { title: string; slug: string; parentId: string | null; content: unknown }) {
    for (let i = 1; i <= 20; i++) {
      try {
        return await this.pages.create(actor, siteId, { ...body, slug: i === 1 ? body.slug : `${body.slug.slice(0, 74)}-${i}` });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'PATH_TAKEN')) throw err;
      }
    }
    throw new Error('No free address');
  }
}

const n = (type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id: newId(), type, props, children });
const narrow = (children: BlockNode[]) => ({ root: n('section', {}, [n('section', { background: 'default', paddingY: 'lg', width: 'narrow' }, children)]) });
const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
function postTemplate() {
  return narrow([n('heading', { text: '{{entry.title}}', level: 1, align: 'left' }), n('text', { doc: para('{{entry.publishedOn}} · {{entry.author}}'), align: 'left' }), n('text', { doc: para('{{entry.body}}'), align: 'left' })]);
}
function pageContent(title: string, doc: unknown) {
  return narrow([n('heading', { text: title || 'Untitled', level: 1, align: 'left' }), n('text', { doc, align: 'left' })]);
}

@ApiTags('migration')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/migrations', version: '1' })
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  @Post('wordpress')
  @HttpCode(200)
  @RequirePermission('create', 'Page')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import a WordPress export (WXR, multipart "file"): posts → Blog collection with entry pages, pages → pages, old URLs → 301. ?dryRun=true reports only' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  wordpress(@Param('siteId') siteId: string, @UploadedFile() file: Express.Multer.File | undefined, @Query('dryRun') dryRun: string | undefined, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the export in the multipart field "file"');
    return this.migration.wordpress(p, abilityOf(req), siteId, file.buffer, dryRun === 'true' || dryRun === '1');
  }
}

@Module({
  imports: [SitesModule, CollectionsModule, PagesModule, SeoModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
