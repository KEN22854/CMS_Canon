import type { PageContent } from '@canon/blocks';
import { applyBlockPatch, HIDDEN, type BlockPatch } from '@canon/edge';
import type { Page } from '@canon/db';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { BlockRegistry } from '../../infrastructure/blocks/block-registry';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * A variant or personalization patch must produce a page the renderer can draw: every target
 * block exists, and the patched tree passes the same validation as a saved page. Checked against
 * the published snapshot (what visitors see), falling back to the draft for unpublished pages.
 */
@Injectable()
export class PatchValidator {
  constructor(
    private readonly blocks: BlockRegistry,
    private readonly system: SystemPrismaService,
  ) {}

  async baseContent(page: Pick<Page, 'id' | 'publishedVersion' | 'content'>): Promise<PageContent> {
    if (page.publishedVersion) {
      const v = await this.system.pageVersion.findUnique({ where: { pageId_version: { pageId: page.id, version: page.publishedVersion } }, select: { content: true } });
      if (v) return v.content as unknown as PageContent;
    }
    return page.content as unknown as PageContent;
  }

  async validate(base: PageContent, patch: BlockPatch, label: string): Promise<void> {
    const ids = new Set<string>();
    const walk = (n: PageContent['root']) => (ids.add(n.id), n.children.forEach(walk));
    walk(base.root);
    const missing = Object.keys(patch).filter((id) => !ids.has(id));
    if (missing.length) throw new ApiError('INVALID_PATCH', `${label}: unknown block(s) ${missing.join(', ')}`, 422, { missing });
    if (patch[base.root.id]?.[HIDDEN]) throw new ApiError('INVALID_PATCH', `${label}: the page root cannot be hidden`, 422);
    try {
      await this.blocks.validate(applyBlockPatch(base, patch));
    } catch (err) {
      const details = err instanceof ApiError ? err.details : undefined;
      throw new ApiError('INVALID_PATCH', `${label}: the patched page is not valid`, 422, details);
    }
  }
}
