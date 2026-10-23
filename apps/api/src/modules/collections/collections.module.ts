import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseIntPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { RequirePermission } from '../../common/auth/decorators';
import { abilityOf } from '../../common/auth/permissions.guard';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest, forbidden } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { ContentAiModule } from '../content-ai/content-ai.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { SitesModule } from '../sites/sites.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  createCollectionBody,
  createEntryBody,
  duplicateCheckBody,
  enrichBody,
  exportQuery,
  importQuery,
  listEntriesQuery,
  publishEntryBody,
  suggestSchemaBody,
  updateCollectionBody,
  updateEntryBody,
  type CreateCollectionBody,
  type CreateEntryBody,
  type DuplicateCheckBody,
  type EnrichBody,
  type UpdateCollectionBody,
  type UpdateEntryBody,
} from './collections.dto';
import { CollectionsService } from './collections.service';
import { ContentDeliveryService, contentQuery } from './content-delivery.service';
import { EnrichmentQueue } from './enrichment.queue';
import { EnrichmentService } from './enrichment.service';
import { EntriesIoService, MAX_IMPORT_BYTES } from './entries-io.service';
import { EntriesService } from './entries.service';

const truthy = (v?: string) => v === 'true' || v === '1';

@ApiTags('collections')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/collections', version: '1' })
export class CollectionsController {
  constructor(
    private readonly collections: CollectionsService,
    private readonly io: EntriesIoService,
    private readonly enrichment: EnrichmentService,
  ) {}

  @Get()
  @RequirePermission('read', 'Collection')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.collections.list(p.tenantId, siteId);
  }

  @Post()
  @RequirePermission('create', 'Collection')
  @ApiOperation({ summary: 'Create a collection from a field schema (validated by the @canon/fields meta-schema)' })
  create(@Param('siteId') siteId: string, @Body(new ZodBody(createCollectionBody)) body: CreateCollectionBody, @TenantScope() p: TenantPrincipal) {
    return this.collections.create(p, siteId, body);
  }

  @Post('ai/suggest-schema')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Describe a content type in words → suggested, validated field list (not saved)' })
  suggest(@Param('siteId') siteId: string, @Body(new ZodBody(suggestSchemaBody)) body: { description: string }, @TenantScope() p: TenantPrincipal) {
    return this.enrichment.suggestSchema(p, siteId, body.description);
  }

  @Get(':collectionId')
  @RequirePermission('read', 'Collection')
  get(@Param('siteId') siteId: string, @Param('collectionId') id: string, @TenantScope() p: TenantPrincipal) {
    return this.collections.detail(p.tenantId, siteId, id);
  }

  @Patch(':collectionId')
  @RequirePermission('update', 'Collection')
  @ApiOperation({ summary: 'Update name/fields/settings; lossy type changes on fields with data need force: true (409 SCHEMA_CONFLICT)' })
  update(@Param('siteId') siteId: string, @Param('collectionId') id: string, @Body(new ZodBody(updateCollectionBody)) body: UpdateCollectionBody, @TenantScope() p: TenantPrincipal) {
    return this.collections.update(p, siteId, id, body);
  }

  @Delete(':collectionId')
  @HttpCode(204)
  @RequirePermission('delete', 'Collection')
  async remove(@Param('siteId') siteId: string, @Param('collectionId') id: string, @Query('force') force: string | undefined, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.collections.remove(p, siteId, id, truthy(force));
  }

  @Get(':collectionId/export')
  @RequirePermission('read', 'Entry')
  @ApiOperation({ summary: 'Export entries as CSV (Excel-friendly, formula-safe) or lossless JSON' })
  async export(@Param('siteId') siteId: string, @Param('collectionId') id: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal, @Res({ passthrough: true }) res: Response) {
    const file = await this.io.export(p.tenantId, siteId, id, new ZodBody(exportQuery).transform(query));
    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    return file.body;
  }

  @Post(':collectionId/import')
  @HttpCode(200)
  @RequirePermission('create', 'Entry')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import CSV/JSON (multipart "file"); ?mode=upsert|create&dryRun=true&publish=true; per-row error report' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  import(@Param('siteId') siteId: string, @Param('collectionId') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the file in the multipart field "file"');
    const q = new ZodBody(importQuery).transform(query);
    const ability = abilityOf(req);
    if (q.mode === 'upsert' && !ability.can('update', 'Entry')) throw forbidden('Your role cannot update entries — use mode=create');
    if (q.publish && !ability.can('publish', 'Entry')) throw forbidden('Your role cannot publish entries');
    return this.io.import(p, ability, siteId, id, file, q);
  }

  @Post(':collectionId/duplicates')
  @HttpCode(200)
  @RequirePermission('read', 'Entry')
  @ApiOperation({ summary: 'Check unsaved entry data for likely duplicates (content shingles + title trigram)' })
  async duplicates(@Param('siteId') siteId: string, @Param('collectionId') id: string, @Body(new ZodBody(duplicateCheckBody)) body: DuplicateCheckBody, @TenantScope() p: TenantPrincipal) {
    const c = await this.collections.get(p.tenantId, siteId, id);
    return { duplicates: await this.enrichment.checkDraft(p.tenantId, c, body.data, body.locale ?? 'en', body.excludeId) };
  }
}

@ApiTags('collections')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/collections/:collectionId/entries', version: '1' })
export class EntriesController {
  constructor(
    private readonly entries: EntriesService,
    private readonly collections: CollectionsService,
    private readonly enrichment: EnrichmentService,
  ) {}

  @Get()
  @RequirePermission('read', 'Entry')
  @ApiOperation({ summary: 'List entries: full-text q, tag, status, locale, sort (updated|created|title|quality), offset pagination; includes tag counts' })
  list(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.entries.list(p.tenantId, siteId, cid, new ZodBody(listEntriesQuery).transform(query));
  }

  @Post()
  @RequirePermission('create', 'Entry')
  async create(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Body(new ZodBody(createEntryBody)) body: CreateEntryBody, @TenantScope() p: TenantPrincipal) {
    const e = await this.entries.create(p, siteId, cid, body);
    return this.entries.detail(p.tenantId, siteId, cid, e.id);
  }

  @Get(':entryId')
  @RequirePermission('read', 'Entry')
  get(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @TenantScope() p: TenantPrincipal) {
    return this.entries.detail(p.tenantId, siteId, cid, id);
  }

  @Patch(':entryId')
  @RequirePermission('update', 'Entry')
  @ApiOperation({ summary: 'Update with expectedVersion (409 VERSION_CONFLICT on mismatch); drafts may be incomplete' })
  update(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @Body(new ZodBody(updateEntryBody)) body: UpdateEntryBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.entries.update(p, abilityOf(req), siteId, cid, id, body);
  }

  @Delete(':entryId')
  @HttpCode(204)
  @RequirePermission('delete', 'Entry')
  async remove(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @Query('force') force: string | undefined, @TenantScope() p: TenantPrincipal, @Req() req: Request): Promise<void> {
    await this.entries.remove(p, abilityOf(req), siteId, cid, id, truthy(force));
  }

  @Post(':entryId/publish')
  @HttpCode(200)
  @RequirePermission('publish', 'Entry')
  @ApiOperation({ summary: 'Validate required fields and snapshot the draft; delivery serves only snapshots' })
  publish(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @Body(new ZodBody(publishEntryBody)) body: { comment?: string }, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.entries.publish(p, abilityOf(req), siteId, cid, id, body.comment);
  }

  @Post(':entryId/unpublish')
  @HttpCode(200)
  @RequirePermission('publish', 'Entry')
  unpublish(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.entries.unpublish(p, abilityOf(req), siteId, cid, id);
  }

  @Get(':entryId/versions')
  @RequirePermission('read', 'Entry')
  versions(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @TenantScope() p: TenantPrincipal) {
    return this.entries.versions(p.tenantId, siteId, cid, id);
  }

  @Post(':entryId/versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('update', 'Entry')
  restore(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @Param('version', ParseIntPipe) version: number, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    return this.entries.restore(p, abilityOf(req), siteId, cid, id, version);
  }

  @Post(':entryId/duplicate')
  @RequirePermission('create', 'Entry')
  async duplicate(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @TenantScope() p: TenantPrincipal) {
    const e = await this.entries.duplicate(p, siteId, cid, id);
    return this.entries.detail(p.tenantId, siteId, cid, e.id);
  }

  @Post(':entryId/ai-enrich')
  @HttpCode(200)
  @RequirePermission('invoke', 'Ai')
  @ApiOperation({ summary: 'Run AI enrichment now: tags, summary, quality score, embedding + duplicate check' })
  async enrich(@Param('siteId') siteId: string, @Param('collectionId') cid: string, @Param('entryId') id: string, @Body(new ZodBody(enrichBody)) body: EnrichBody, @TenantScope() p: TenantPrincipal, @Req() req: Request) {
    const c = await this.collections.get(p.tenantId, siteId, cid);
    const e = await this.entries.get(p.tenantId, cid, id);
    if (body.applyTags && !abilityOf(req).can('update', 'Entry')) throw forbidden('Your role cannot change entry tags');
    const res = await this.enrichment.enrich(p, c, e, body, true);
    return { ...res, entry: await this.entries.detail(p.tenantId, siteId, cid, id) };
  }
}

/** Headless read API: published snapshots only. Works with API keys that have content:read. */
@ApiTags('content')
@ApiBearerAuth()
@Controller({ path: 'content/sites/:siteId', version: '1' })
export class ContentController {
  constructor(private readonly content: ContentDeliveryService) {}

  @Get('collections')
  @RequirePermission('read', 'Collection')
  collections(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.content.collectionsOf(p.tenantId, siteId);
  }

  @Get('collections/:slug/entries')
  @RequirePermission('read', 'Entry')
  @ApiOperation({ summary: 'Published entries (locale, tag, sort, limit/offset, expand=true resolves relations)' })
  entries(@Param('siteId') siteId: string, @Param('slug') slug: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.content.entries(p.tenantId, siteId, slug, new ZodBody(contentQuery).transform(query));
  }

  @Get('collections/:slug/entries/:entrySlug')
  @RequirePermission('read', 'Entry')
  entry(@Param('siteId') siteId: string, @Param('slug') slug: string, @Param('entrySlug') entrySlug: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    const q = new ZodBody(contentQuery).transform(query);
    return this.content.entry(p.tenantId, siteId, slug, entrySlug, q);
  }
}

@Module({
  imports: [SitesModule, TenancyModule, IntelligenceModule, ContentAiModule],
  controllers: [CollectionsController, EntriesController, ContentController],
  providers: [CollectionsService, EntriesService, EntriesIoService, EnrichmentQueue, EnrichmentService, ContentDeliveryService],
  exports: [CollectionsService, EntriesService],
})
export class CollectionsModule {}
