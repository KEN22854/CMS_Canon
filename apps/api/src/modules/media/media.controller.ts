import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { listMediaQuery, presignBody, updateMediaBody, uploadFields, type PresignBody, type UpdateMediaBody } from './media.dto';
import { MediaService } from './media.service';

// Multer needs the cap at decoration time; the service re-checks against the validated config.
const MAX_UPLOAD_BYTES = Number(process.env.MEDIA_MAX_UPLOAD_MB ?? 25) * 1_048_576;

@ApiTags('media')
@ApiBearerAuth()
@Controller({ version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('sites/:siteId/media')
  @RequirePermission('read', 'Media')
  list(@Param('siteId') siteId: string, @Query() query: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    return this.media.list(p.tenantId, siteId, new ZodBody(listMediaQuery).transform(query));
  }

  @Post('sites/:siteId/media/upload')
  @RequirePermission('create', 'Media')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file (multipart field "file"); images get webp/avif variants; identical bytes are deduplicated' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@Param('siteId') siteId: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() fields: Record<string, string>, @TenantScope() p: TenantPrincipal) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Send the file in the multipart field "file"');
    return this.media.upload(p, siteId, file, new ZodBody(uploadFields).transform(fields));
  }

  @Post('sites/:siteId/media/presign')
  @RequirePermission('create', 'Media')
  @ApiOperation({ summary: 'Presigned PUT for large files; call /media/:id/complete afterwards' })
  presign(@Param('siteId') siteId: string, @Body(new ZodBody(presignBody)) body: PresignBody, @TenantScope() p: TenantPrincipal) {
    return this.media.presign(p, siteId, body);
  }

  @Post('media/:mediaId/complete')
  @HttpCode(200)
  @RequirePermission('create', 'Media')
  complete(@Param('mediaId') mediaId: string, @TenantScope() p: TenantPrincipal) {
    return this.media.complete(p, mediaId);
  }

  @Get('media/:mediaId')
  @RequirePermission('read', 'Media')
  async get(@Param('mediaId') mediaId: string, @TenantScope() p: TenantPrincipal) {
    return this.media.present(await this.media.get(p.tenantId, mediaId));
  }

  @Get('media/:mediaId/usage')
  @RequirePermission('read', 'Media')
  usage(@Param('mediaId') mediaId: string, @TenantScope() p: TenantPrincipal) {
    return this.media.usage(p.tenantId, mediaId);
  }

  @Patch('media/:mediaId')
  @RequirePermission('update', 'Media')
  update(@Param('mediaId') mediaId: string, @Body(new ZodBody(updateMediaBody)) body: UpdateMediaBody, @TenantScope() p: TenantPrincipal) {
    return this.media.update(p, mediaId, body);
  }

  @Delete('media/:mediaId')
  @HttpCode(204)
  @RequirePermission('delete', 'Media')
  async remove(@Param('mediaId') mediaId: string, @Query('force') force: string | undefined, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.media.remove(p, mediaId, force === 'true');
  }
}
