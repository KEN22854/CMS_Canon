import { componentTreeIssues, type BlockNode, type PageContent } from '@canon/blocks';
import { Prisma, type SiteComponent } from '@canon/db';
import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { badRequest, conflict, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { BlockRegistry } from '../../infrastructure/blocks/block-registry';
import { Outbox } from '../../infrastructure/events/outbox';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';

const createBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  tree: z.unknown(),
});
const updateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  tree: z.unknown().optional(),
  /** Optimistic lock: the version the editor started from. */
  version: z.number().int().min(1),
});
type CreateBody = z.infer<typeof createBody>;
type UpdateBody = z.infer<typeof updateBody>;

const MAX_COMPONENTS_PER_SITE = 200;

/**
 * Global components (symbols): one block tree used on many pages through "component" blocks.
 * The builder edits `tree`; publishing copies it to `publishedTree`, which is what delivery
 * expands, so a half-edited header never reaches the live site. Permissions follow pages.
 */
@Injectable()
export class ComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesService,
    private readonly blocks: BlockRegistry,
    private readonly outbox: Outbox,
    private readonly audit: AuditService,
  ) {}

  async list(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).siteComponent.findMany({ where: { tenantId, siteId, deletedAt: null }, orderBy: { name: 'asc' } });
    return rows.map(present);
  }

  async get(tenantId: string, id: string): Promise<SiteComponent> {
    const c = await this.prisma.forTenant({ tenantId }).siteComponent.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!c) throw notFound('Component');
    return c;
  }

  async create(actor: TenantPrincipal, siteId: string, body: CreateBody) {
    await this.sites.get(actor.tenantId, siteId);
    const tree = await this.validTree(body.tree);
    const count = await this.prisma.forTenant({ tenantId: actor.tenantId }).siteComponent.count({ where: { siteId, deletedAt: null } });
    if (count >= MAX_COMPONENTS_PER_SITE) throw badRequest('COMPONENT_LIMIT', `A site can have at most ${MAX_COMPONENTS_PER_SITE} components`);
    const c = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
      tx.siteComponent.create({
        data: { tenantId: actor.tenantId, siteId, name: body.name, description: body.description ?? null, tree: tree as unknown as Prisma.InputJsonValue, createdById: actor.userId, updatedById: actor.userId },
      }),
    );
    await this.audit.record({ tenantId: actor.tenantId, action: 'component.created', entityType: 'SiteComponent', entityId: c.id, changes: { name: body.name } }, actor);
    return present(c);
  }

  async update(actor: TenantPrincipal, id: string, body: UpdateBody) {
    const current = await this.get(actor.tenantId, id);
    if (current.version !== body.version) throw conflict('The component was changed by someone else; reload it');
    const data: Prisma.SiteComponentUpdateInput = { version: { increment: 1 }, updatedById: actor.userId };
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.tree !== undefined) data.tree = (await this.validTree(body.tree)) as unknown as Prisma.InputJsonValue;
    const c = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      // Compare-and-set on the version, so two saves can't both win.
      const res = await tx.siteComponent.updateMany({ where: { id, version: body.version, deletedAt: null }, data: data as Prisma.SiteComponentUpdateManyMutationInput });
      if (res.count === 0) throw conflict('The component was changed by someone else; reload it');
      return tx.siteComponent.findUniqueOrThrow({ where: { id } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'component.updated', entityType: 'SiteComponent', entityId: id, changes: Object.keys(body).filter((k) => k !== 'version') }, actor);
    return present(c);
  }

  /** Makes the working copy live on every page that uses the component. */
  async publish(actor: TenantPrincipal, id: string) {
    const current = await this.get(actor.tenantId, id);
    const c = await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      const updated = await tx.siteComponent.update({ where: { id }, data: { publishedTree: current.tree as Prisma.InputJsonValue, publishedVersion: current.version, publishedAt: new Date() } });
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'SiteComponent', aggregateId: id, type: 'ComponentPublished', payload: { siteId: current.siteId, componentId: id, version: current.version } });
      return updated;
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'component.published', entityType: 'SiteComponent', entityId: id, changes: { version: current.version } }, actor);
    return present(c);
  }

  /** Soft delete; instances on live pages render nothing from the next delivery on. */
  async remove(actor: TenantPrincipal, id: string): Promise<void> {
    const current = await this.get(actor.tenantId, id);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.siteComponent.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.outbox.enqueue(tx, { tenantId: actor.tenantId, aggregateType: 'SiteComponent', aggregateId: id, type: 'ComponentPublished', payload: { siteId: current.siteId, componentId: id, deleted: true } });
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'component.deleted', entityType: 'SiteComponent', entityId: id }, actor);
  }

  /** Same rules as page content (the tree is validated as the only child of a page), plus no recursion. */
  private async validTree(input: unknown): Promise<BlockNode> {
    if (!input || typeof input !== 'object') throw badRequest('INVALID_CONTENT', 'Component tree is required');
    const issues = componentTreeIssues(input as BlockNode);
    if (issues.length) throw badRequest('INVALID_CONTENT', issues[0]!, { issues: issues.map((message) => ({ path: 'tree', message })) });
    const content: PageContent = await this.blocks.validate({ root: { id: '__component', type: 'section', props: {}, children: [input] } });
    return content.root.children[0]!;
  }
}

function present(c: SiteComponent) {
  return {
    id: c.id,
    siteId: c.siteId,
    name: c.name,
    description: c.description,
    tree: c.tree as unknown as BlockNode,
    version: c.version,
    publishedVersion: c.publishedVersion,
    publishedAt: c.publishedAt,
    /** True when the working copy differs from what the site shows. */
    hasUnpublishedChanges: c.publishedVersion !== c.version,
    updatedAt: c.updatedAt,
  };
}

@ApiTags('components')
@ApiBearerAuth()
@Controller({ version: '1' })
export class ComponentsController {
  constructor(private readonly components: ComponentsService) {}

  @Get('sites/:siteId/components')
  @RequirePermission('read', 'Page')
  list(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.components.list(p.tenantId, siteId);
  }

  @Post('sites/:siteId/components')
  @RequirePermission('create', 'Page')
  @ApiOperation({ summary: 'Create a global component from a block tree' })
  create(@Param('siteId') siteId: string, @Body(new ZodBody(createBody)) body: CreateBody, @TenantScope() p: TenantPrincipal) {
    return this.components.create(p, siteId, body);
  }

  @Get('components/:id')
  @RequirePermission('read', 'Page')
  async get(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return present(await this.components.get(p.tenantId, id));
  }

  @Patch('components/:id')
  @RequirePermission('update', 'Page')
  update(@Param('id') id: string, @Body(new ZodBody(updateBody)) body: UpdateBody, @TenantScope() p: TenantPrincipal) {
    return this.components.update(p, id, body);
  }

  @Post('components/:id/publish')
  @HttpCode(200)
  @RequirePermission('publish', 'Page')
  @ApiOperation({ summary: 'Publish the component: every live page that uses it updates' })
  publish(@Param('id') id: string, @TenantScope() p: TenantPrincipal) {
    return this.components.publish(p, id);
  }

  @Delete('components/:id')
  @HttpCode(204)
  @RequirePermission('delete', 'Page')
  async remove(@Param('id') id: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.components.remove(p, id);
  }
}

@Module({ imports: [SitesModule], controllers: [ComponentsController], providers: [ComponentsService], exports: [ComponentsService] })
export class ComponentsModule {}
