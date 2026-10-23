import { validatePageContent, type PageContent, type TreeIssue } from '@canon/blocks';
import { Global, Injectable, Module } from '@nestjs/common';
import { badRequest } from '../../common/http/api-error';
import { SystemPrismaService } from '../prisma/prisma.service';

const TTL_MS = 60_000;
/** Stored trees are bounded so a single page cannot bloat delivery responses or the editor. */
const MAX_CONTENT_BYTES = 1_000_000;

/**
 * DB block registry (core + plugin blocks) layered over the code registry in @canon/blocks:
 * code defines props for the blocks we render, the DB says which other types are installed.
 */
@Injectable()
export class BlockRegistry {
  private cache?: { types: Set<string>; containers: Set<string>; at: number };

  constructor(private readonly system: SystemPrismaService) {}

  async validate(content: unknown): Promise<PageContent> {
    if (JSON.stringify(content ?? null).length > MAX_CONTENT_BYTES) {
      throw badRequest('CONTENT_TOO_LARGE', `Page content exceeds ${MAX_CONTENT_BYTES / 1_000_000} MB`);
    }
    const { types, containers } = await this.load();
    const res = validatePageContent(content, { registeredTypes: types, containerTypes: containers });
    if (!res.ok) throw badRequest('INVALID_CONTENT', 'Page content is invalid', { issues: res.issues satisfies TreeIssue[] });
    return res.content;
  }

  private async load(): Promise<{ types: Set<string>; containers: Set<string> }> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache;
    const rows = await this.system.block.findMany({ select: { type: true, isContainer: true } });
    this.cache = { types: new Set(rows.map((r) => r.type)), containers: new Set(rows.filter((r) => r.isContainer).map((r) => r.type)), at: Date.now() };
    return this.cache;
  }
}

@Global()
@Module({ providers: [BlockRegistry], exports: [BlockRegistry] })
export class BlocksModule {}
