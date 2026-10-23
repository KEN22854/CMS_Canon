import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { Prisma, type Media } from '@canon/db';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, notFound, quotaExceeded } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { Storage } from '../../infrastructure/storage/storage';
import { SitesService } from '../sites/sites.service';
import { TenantsService } from '../tenancy/tenants.service';
import { processImage } from './image-processor';
import type { ListMediaQuery, PresignBody, UpdateMediaBody } from './media.dto';
import { sniff, type MediaKind } from './sniff';

const PRESIGN_TTL_SEC = 900;

export interface MediaVariants {
  thumb?: { url: string; width: number; height: number };
  sources: { url: string; width: number; height: number; format: 'webp' | 'avif' }[];
}

const KIND_PREFIX: Record<MediaKind, string> = { image: 'image/', video: 'video/', document: 'application/' };

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: Storage,
    private readonly sites: SitesService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MediaService.name);
  }

  // ── ingest ─────────────────────────────────────────────────────────────────

  /** Direct upload (≤ MEDIA_MAX_UPLOAD_MB). Returns the existing item when the same bytes are already in the site. */
  async upload(actor: TenantPrincipal, siteId: string, file: { buffer: Buffer; originalname: string }, opts: { folder: string; alt?: string }) {
    await this.sites.get(actor.tenantId, siteId);
    const prepared = this.inspect(file.buffer);
    const duplicate = await this.findDuplicate(actor.tenantId, siteId, prepared.hash);
    if (duplicate) return { ...this.present(duplicate), duplicate: true };
    await this.assertStorage(actor.tenantId, file.buffer.length);

    const id = createId();
    const storageKey = keyFor(actor.tenantId, siteId, id, `original.${prepared.sniffed.ext}`);
    const media = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).media.create({
      data: {
        id,
        tenantId: actor.tenantId,
        siteId,
        filename: `${id}.${prepared.sniffed.ext}`,
        originalName: cleanName(file.originalname),
        mimeType: prepared.sniffed.mime,
        size: BigInt(file.buffer.length),
        contentHash: prepared.hash,
        storageKey,
        status: 'PROCESSING',
        url: this.storage.publicUrl(storageKey),
        folder: opts.folder,
        alt: opts.alt ?? null,
        uploadedById: actor.userId ?? null,
      },
    });
    const ready = await this.process(actor.tenantId, media, file.buffer);
    await this.audit.record({ tenantId: actor.tenantId, action: 'media.uploaded', entityType: 'Media', entityId: id, changes: { mime: prepared.sniffed.mime, size: file.buffer.length } }, actor);
    return { ...this.present(ready), duplicate: false };
  }

  /** Large files go browser → object store directly; the API only signs and later verifies. */
  async presign(actor: TenantPrincipal, siteId: string, body: PresignBody) {
    await this.sites.get(actor.tenantId, siteId);
    const maxBytes = 5_000 * 1_048_576;
    if (body.size > maxBytes) throw badRequest('FILE_TOO_LARGE', 'Files are limited to 5 GB');
    await this.assertStorage(actor.tenantId, body.size);
    const ext = (body.filename.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const id = createId();
    const storageKey = keyFor(actor.tenantId, siteId, id, `original.${ext}`);
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).media.create({
      data: {
        id,
        tenantId: actor.tenantId,
        siteId,
        filename: `${id}.${ext}`,
        originalName: cleanName(body.filename),
        mimeType: body.contentType,
        size: BigInt(body.size),
        contentHash: '',
        storageKey,
        status: 'PENDING_UPLOAD',
        url: this.storage.publicUrl(storageKey),
        folder: body.folder,
        uploadedById: actor.userId ?? null,
      },
    });
    return { mediaId: id, uploadUrl: await this.storage.presignPut(storageKey, body.contentType, PRESIGN_TTL_SEC), method: 'PUT', headers: { 'content-type': body.contentType }, expiresInSec: PRESIGN_TTL_SEC };
  }

  async complete(actor: TenantPrincipal, mediaId: string) {
    const media = await this.get(actor.tenantId, mediaId);
    if (media.status !== 'PENDING_UPLOAD') return this.present(media);
    const head = await this.storage.head(media.storageKey);
    if (!head) throw badRequest('UPLOAD_MISSING', 'The file has not been uploaded yet');
    const buffer = await this.storage.get(media.storageKey);
    let prepared: ReturnType<MediaService['inspect']>;
    try {
      prepared = this.inspect(buffer);
    } catch (err) {
      await this.discard(actor.tenantId, media);
      throw err;
    }
    const duplicate = await this.findDuplicate(actor.tenantId, media.siteId, prepared.hash);
    if (duplicate) {
      await this.discard(actor.tenantId, media);
      return { ...this.present(duplicate), duplicate: true };
    }
    const updated = await this.prisma.forTenant({ tenantId: actor.tenantId }).media.update({
      where: { id: media.id },
      data: { status: 'PROCESSING', mimeType: prepared.sniffed.mime, size: BigInt(buffer.length), contentHash: prepared.hash },
    });
    const ready = await this.process(actor.tenantId, updated, buffer);
    return { ...this.present(ready), duplicate: false };
  }

  // ── reads & edits ──────────────────────────────────────────────────────────

  async list(tenantId: string, siteId: string, q: ListMediaQuery) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).media.findMany({
      where: {
        tenantId,
        siteId,
        deletedAt: null,
        status: { in: ['READY', 'PROCESSING'] },
        ...(q.folder ? { folder: q.folder } : {}),
        ...(q.tag ? { tags: { has: q.tag } } : {}),
        ...(q.kind ? { mimeType: { startsWith: KIND_PREFIX[q.kind] } } : {}),
        ...(q.q ? { OR: [{ originalName: { contains: q.q, mode: 'insensitive' } }, { alt: { contains: q.q, mode: 'insensitive' } }, { title: { contains: q.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map((m) => this.present(m));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id : null };
  }

  async get(tenantId: string, mediaId: string): Promise<Media> {
    const m = await this.prisma.forTenant({ tenantId }).media.findFirst({ where: { id: mediaId, tenantId, deletedAt: null } });
    if (!m) throw notFound('Media');
    return m;
  }

  async update(actor: TenantPrincipal, mediaId: string, body: UpdateMediaBody) {
    await this.get(actor.tenantId, mediaId);
    const data: Prisma.MediaUpdateInput = { ...body };
    // A human edit of the alt text supersedes the generated one.
    if (body.alt !== undefined) data.altGenerated = false;
    const m = await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).media.update({ where: { id: mediaId }, data });
    return this.present(m);
  }

  async setGeneratedAlt(tenantId: string, mediaId: string, alt: string) {
    const m = await this.prisma.forTenant({ tenantId }).media.update({ where: { id: mediaId }, data: { alt, altGenerated: true } });
    return this.present(m);
  }

  /** Pages whose draft or live snapshot reference the media id anywhere in their block tree. */
  async usage(tenantId: string, mediaId: string) {
    const media = await this.get(tenantId, mediaId);
    return this.prisma.rawForTenant({ tenantId }, (tx) =>
      tx.$queryRaw<{ id: string; title: string; fullPath: string; locale: string }[]>`
        SELECT id, title, "fullPath", locale FROM pages
        WHERE "siteId" = ${media.siteId} AND "deletedAt" IS NULL
          AND jsonb_path_exists(content, '$.** ? (@.type() == "string" && @ == $id)', jsonb_build_object('id', ${mediaId}::text))
        LIMIT 50`,
    );
  }

  async remove(actor: TenantPrincipal, mediaId: string, force: boolean): Promise<void> {
    const media = await this.get(actor.tenantId, mediaId);
    const used = await this.usage(actor.tenantId, mediaId);
    if (used.length > 0 && !force) {
      throw new ApiError('MEDIA_IN_USE', `Used on ${used.length} page(s); pass ?force=true to delete anyway`, 409, { pages: used });
    }
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).media.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
    // Objects are removed after the soft delete; a crash in between leaves orphaned objects, not broken pages.
    await this.storage.deletePrefix(prefixFor(media)).catch((err: unknown) => this.logger.warn({ err, mediaId }, 'media.object_delete_failed'));
    await this.audit.record({ tenantId: actor.tenantId, action: 'media.deleted', entityType: 'Media', entityId: mediaId, changes: { forced: force && used.length > 0 } }, actor);
  }

  /** Bytes of the smallest raster rendition — enough for vision models at a fraction of the tokens. */
  /** Image bytes for a vision model: the small thumbnail by default; `detail` sends the original (≤ 4 MB) for layout references. */
  async visionInput(tenantId: string, mediaId: string, opts: { detail?: boolean } = {}): Promise<{ media: Media; data: string; mediaType: 'image/webp' | 'image/png' | 'image/jpeg' | 'image/gif' }> {
    const media = await this.get(tenantId, mediaId);
    if (!media.mimeType.startsWith('image/') || media.status !== 'READY') throw badRequest('NOT_AN_IMAGE', 'Only processed images can be sent to a vision model');
    const visionTypes = ['image/webp', 'image/png', 'image/jpeg', 'image/gif'];
    if (opts.detail && media.size <= 4n * 1024n * 1024n && visionTypes.includes(media.mimeType)) {
      return { media, data: (await this.storage.get(media.storageKey)).toString('base64'), mediaType: media.mimeType as 'image/png' };
    }
    const thumbKey = `${prefixFor(media)}thumb.webp`;
    if (await this.storage.head(thumbKey)) return { media, data: (await this.storage.get(thumbKey)).toString('base64'), mediaType: 'image/webp' };
    return { media, data: (await this.storage.get(media.storageKey)).toString('base64'), mediaType: media.mimeType as 'image/png' };
  }

  /** Delivery-shaped view (renderer and editor previews). */
  present(m: Media) {
    return {
      id: m.id,
      siteId: m.siteId,
      status: m.status,
      originalName: m.originalName,
      mimeType: m.mimeType,
      size: Number(m.size),
      width: m.width,
      height: m.height,
      url: m.url,
      thumbnailUrl: m.thumbnailUrl,
      variants: m.variants as unknown as MediaVariants,
      alt: m.alt,
      altGenerated: m.altGenerated,
      caption: m.caption,
      title: m.title,
      folder: m.folder,
      tags: m.tags,
      dominantColor: (m.aiMetadata as { dominantColors?: string[] }).dominantColors?.[0] ?? null,
      createdAt: m.createdAt,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private inspect(buffer: Buffer) {
    const max = this.config.MEDIA_MAX_UPLOAD_MB * 1_048_576;
    if (buffer.length === 0) throw badRequest('EMPTY_FILE', 'The file is empty');
    if (buffer.length > max) throw badRequest('FILE_TOO_LARGE', `Direct uploads are limited to ${this.config.MEDIA_MAX_UPLOAD_MB} MB; use presigned upload`);
    const sniffed = sniff(buffer);
    if (!sniffed) throw badRequest('UNSUPPORTED_MEDIA_TYPE', 'Supported: JPEG, PNG, GIF, WebP, AVIF, MP4, WebM, MOV, PDF');
    return { sniffed, hash: createHash('sha256').update(buffer).digest('hex') };
  }

  private async process(tenantId: string, media: Media, buffer: Buffer): Promise<Media> {
    const db = this.prisma.forTenant({ tenantId });
    const prefix = prefixFor(media);
    try {
      if (!media.mimeType.startsWith('image/')) {
        await this.storage.put(media.storageKey, buffer, media.mimeType, { immutable: true });
        return await db.media.update({ where: { id: media.id }, data: { status: 'READY' } });
      }
      const img = await processImage(buffer, media.mimeType);
      await this.storage.put(media.storageKey, img.sanitized.buffer, img.sanitized.contentType, { immutable: true });
      await Promise.all([...img.variants, img.thumb].map((v) => this.storage.put(`${prefix}${v.name}`, v.buffer, v.contentType, { immutable: true })));
      const variants: MediaVariants = {
        thumb: { url: this.storage.publicUrl(`${prefix}${img.thumb.name}`), width: img.thumb.width, height: img.thumb.height },
        sources: img.variants.map((v) => ({ url: this.storage.publicUrl(`${prefix}${v.name}`), width: v.width, height: v.height, format: v.format })),
      };
      return await db.media.update({
        where: { id: media.id },
        data: {
          status: 'READY',
          width: img.width,
          height: img.height,
          size: BigInt(img.sanitized.buffer.length),
          thumbnailUrl: variants.thumb?.url ?? null,
          variants: variants as unknown as Prisma.InputJsonValue,
          metadata: { hasAlpha: img.hasAlpha, animated: img.animated },
          aiMetadata: { dominantColors: [img.dominantColor] },
        },
      });
    } catch (err) {
      this.logger.error({ err, mediaId: media.id }, 'media.processing_failed');
      await db.media.update({ where: { id: media.id }, data: { status: 'FAILED' } });
      throw badRequest('MEDIA_PROCESSING_FAILED', 'The file could not be processed (corrupt or unsupported image)');
    }
  }

  private findDuplicate(tenantId: string, siteId: string, hash: string): Promise<Media | null> {
    return this.prisma.forTenant({ tenantId }).media.findFirst({ where: { tenantId, siteId, contentHash: hash, deletedAt: null, status: 'READY' } });
  }

  private async discard(tenantId: string, media: Media): Promise<void> {
    await this.prisma.forTenant({ tenantId }).media.update({ where: { id: media.id }, data: { deletedAt: new Date(), status: 'FAILED' } });
    await this.storage.deletePrefix(prefixFor(media)).catch(() => undefined);
  }

  private async assertStorage(tenantId: string, incomingBytes: number): Promise<void> {
    const tenant = await this.tenants.get(tenantId);
    const limitMb = this.tenants.limits(tenant).storageMb;
    if (limitMb === null) return;
    const agg = await this.prisma.forTenant({ tenantId }).media.aggregate({ where: { tenantId, deletedAt: null }, _sum: { size: true } });
    const usedBytes = Number(agg._sum.size ?? 0n);
    if (usedBytes + incomingBytes > limitMb * 1_048_576) throw quotaExceeded(`Your ${tenant.plan} plan includes ${limitMb} MB of media storage`, { resource: 'storageMb', limit: limitMb });
  }
}

function keyFor(tenantId: string, siteId: string, mediaId: string, name: string): string {
  // "public/" is the only prefix the bucket policy exposes anonymously.
  return `public/t/${tenantId}/s/${siteId}/${mediaId}/${name}`;
}

function prefixFor(m: Pick<Media, 'tenantId' | 'siteId' | 'id'>): string {
  return `public/t/${m.tenantId}/s/${m.siteId}/${m.id}/`;
}

function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 255) || 'file';
}

