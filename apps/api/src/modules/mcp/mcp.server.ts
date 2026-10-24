import { collectTextFields, richTextToPlain, type PageContent } from '@canon/blocks';
import { subject } from '@casl/ability';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { defineAbilityFor } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { FactsService } from '../canon/facts.service';
import { MentionsService } from '../canon/mentions.service';
import { PropagationService } from '../canon/propagation.service';
import { KnowledgeAnswers } from '../knowledge/answer.service';
import { KnowledgeSearch } from '../knowledge/search.service';
import { PagesService } from '../pages/pages.service';
import { SitesService } from '../sites/sites.service';

// The SDK ships ESM typings with a CJS build: load the CJS build, keep the typings.
/* eslint-disable @typescript-eslint/no-require-imports */
type McpModule = typeof import('@modelcontextprotocol/sdk/server/mcp.js', { with: { 'resolution-mode': 'import' } });
const { McpServer }: McpModule = require('@modelcontextprotocol/sdk/server/mcp.js');
/* eslint-enable @typescript-eslint/no-require-imports */
export type CanonMcpServer = InstanceType<McpModule['McpServer']>;

const INSTRUCTIONS = `Canon is a headless CMS with a fact graph ("Canon"). Facts (prices, limits, dates) are the single source of truth: when you write or check copy, look facts up instead of guessing, and use lint_text to find contradictions. Writes never go live: create_draft_page makes a draft, propose_fact_change opens a branch that a human reviews and merges.`;

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: (Array.isArray(data) ? { items: data } : data) as Record<string, unknown> });
const fail = (err: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'Tool failed' }] });

/**
 * Canon as an MCP server for AI agents (Claude, IDEs, internal bots). One server per request,
 * bound to the caller's API key: the tool list is what the key's scopes allow, every call goes
 * through the same services, RLS and audit as the REST API, and nothing an agent does publishes.
 */
@Injectable()
export class McpFactory {
  constructor(
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly pages: PagesService,
    private readonly search: KnowledgeSearch,
    private readonly answers: KnowledgeAnswers,
    private readonly facts: FactsService,
    private readonly mentions: MentionsService,
    private readonly propagation: PropagationService,
  ) {}

  create(p: TenantPrincipal): CanonMcpServer {
    const ability = defineAbilityFor(p);
    const server = new McpServer({ name: 'canon-cms', version: '1.0.0' }, { instructions: INSTRUCTIONS });
    const t = p.tenantId;
    const run =
      <A>(fn: (args: A) => Promise<unknown>) =>
      async (args: A) => {
        try {
          return ok(await fn(args));
        } catch (err) {
          return fail(err);
        }
      };
    const readOnly = { readOnlyHint: true, openWorldHint: false };

    if (ability.can('read', 'Site')) {
      server.registerTool('list_sites', { title: 'List sites', description: 'Sites in this workspace with their locales and domains.', annotations: readOnly }, run(async () => (await this.sites.list(t)).map((s) => ({ id: s.id, name: s.name, defaultLocale: s.defaultLocale, locales: s.locales, domain: s.domain ?? s.internalDomain }))));
    }

    if (ability.can('read', 'Page')) {
      server.registerTool(
        'list_pages',
        { title: 'List pages', description: 'Pages of a site (draft and published), newest first. Filter by text or status.', inputSchema: { siteId: z.string(), q: z.string().max(100).optional(), status: z.enum(['DRAFT', 'PUBLISHED']).optional(), limit: z.number().int().min(1).max(100).default(30) }, annotations: readOnly },
        run(async (a: { siteId: string; q?: string; status?: 'DRAFT' | 'PUBLISHED'; limit: number }) => {
          const r = await this.pages.list(t, a.siteId, { q: a.q, status: a.status, limit: a.limit });
          return (r as { items: { id: string; title: string; fullPath: string; locale: string; status: string; updatedAt: Date }[] }).items.map((x) => ({ id: x.id, title: x.title, path: x.fullPath, locale: x.locale, status: x.status, updatedAt: x.updatedAt }));
        }),
      );
      server.registerTool(
        'get_page',
        { title: 'Read a page', description: 'A page’s title, SEO and text content (block by block). Use format "json" for the full block tree.', inputSchema: { siteId: z.string(), pageId: z.string(), format: z.enum(['text', 'json']).default('text') }, annotations: readOnly },
        run(async (a: { siteId: string; pageId: string; format: 'text' | 'json' }) => {
          const page = await this.pages.get(t, a.siteId, a.pageId);
          const content = page.content as unknown as PageContent;
          return {
            id: page.id,
            title: page.title,
            path: page.fullPath,
            locale: page.locale,
            status: page.status,
            version: page.version,
            seo: page.seo,
            ...(a.format === 'json' ? { content } : { text: collectTextFields(content).map((f) => ({ blockId: f.blockId, prop: f.item ? `${f.prop}[${f.item.index}].${f.item.prop}` : f.prop, text: typeof f.value === 'string' ? f.value : richTextToPlain(f.value) })) }),
          };
        }),
      );
      server.registerTool(
        'search_content',
        { title: 'Search content', description: 'Hybrid (full-text + semantic) search over published pages and entries of a site.', inputSchema: { siteId: z.string(), query: z.string().min(1).max(300), locale: z.string().max(10).optional(), limit: z.number().int().min(1).max(20).default(8) }, annotations: readOnly },
        run(async (a: { siteId: string; query: string; locale?: string; limit: number }) => (await this.search.search(t, a.siteId, a.query, { locale: a.locale, limit: a.limit })).hits),
      );
    }

    if (ability.can('read', 'Page') && ability.can('invoke', 'Ai')) {
      server.registerTool(
        'ask',
        { title: 'Ask the site', description: 'A grounded answer from the site’s published content and Canon facts, with citations.', inputSchema: { siteId: z.string(), question: z.string().min(3).max(500), locale: z.string().max(10).optional() }, annotations: { readOnlyHint: true } },
        run(async (a: { siteId: string; question: string; locale?: string }) => this.answers.ask(p, a.siteId, a.question, a.locale)),
      );
    }

    if (ability.can('read', 'Fact')) {
      server.registerTool(
        'list_facts',
        { title: 'List Canon facts', description: 'Facts (the source of truth for prices, limits, dates…), optionally filtered by text or site.', inputSchema: { siteId: z.string().optional(), q: z.string().max(100).optional() }, annotations: readOnly },
        run(async (a: { siteId?: string; q?: string }) => (await this.facts.list(t, { siteId: a.siteId, q: a.q })) as unknown),
      );
      server.registerTool(
        'lint_text',
        { title: 'Check text against Canon', description: 'Finds statements in a text that mention Canon facts and whether they agree with the current value.', inputSchema: { siteId: z.string(), text: z.string().min(1).max(20_000) }, annotations: readOnly },
        run(async (a: { siteId: string; text: string }) => {
          const spans = await this.mentions.lint(t, a.siteId, a.text);
          return { contradictions: spans.filter((s) => !s.inSync).length, spans };
        }),
      );
    }

    if (ability.can('create', 'Page')) {
      server.registerTool(
        'create_draft_page',
        { title: 'Create a draft page', description: 'Creates an unpublished page. Content is a block tree (see get_page format "json"); omit it for an empty page. A human publishes.', inputSchema: { siteId: z.string(), title: z.string().min(1).max(200), slug: z.string().regex(/^[a-z0-9-]{1,80}$/), locale: z.string().max(10).optional(), description: z.string().max(500).optional(), content: z.unknown().optional() }, annotations: { destructiveHint: false, idempotentHint: false } },
        run(async (a: { siteId: string; title: string; slug: string; locale?: string; description?: string; content?: unknown }) => {
          const page = await this.pages.create(p, a.siteId, { title: a.title, slug: a.slug, locale: a.locale, description: a.description, content: a.content });
          return { id: page.id, path: page.fullPath, status: page.status, version: page.version, note: 'Draft created — not published.' };
        }),
      );
    }

    if (ability.can('update', 'Fact') && ability.can('create', 'Branch')) {
      server.registerTool(
        'propose_fact_change',
        {
          title: 'Change a fact and propose site updates',
          description: 'Records a new value for a Canon fact, then opens a review branch where the agent team rewrites every page that mentions it. Nothing is merged or published without a human.',
          inputSchema: { factKey: z.string().max(120), siteId: z.string(), value: z.record(z.string(), z.unknown()), reason: z.string().min(3).max(300) },
          annotations: { destructiveHint: false, idempotentHint: false },
        },
        run(async (a: { factKey: string; siteId: string; value: Record<string, unknown>; reason: string }) => {
          const row = await this.system.fact.findFirst({ where: { tenantId: t, key: a.factKey, deletedAt: null }, select: { id: true, tenantId: true } });
          if (!row) throw new ApiError('NOT_FOUND', `No fact "${a.factKey}"`, 404);
          if (!ability.can('update', subject('Fact', row))) throw new ApiError('FORBIDDEN', 'This key cannot change facts', 403);
          const updated = await this.facts.update(p, row.id, { value: a.value, reason: a.reason });
          const branch = await this.propagation.propose(p, row.id, a.siteId).catch((err: unknown) => (err instanceof ApiError && err.code === 'NOTHING_TO_PROPAGATE' ? { branchId: null, note: err.message } : Promise.reject(err)));
          const fact = updated.fact as { displayValue: string; version: number };
          return { fact: { key: a.factKey, displayValue: fact.displayValue, version: fact.version }, affectedPages: updated.impact.totals, ...branch };
        }),
      );
    }
    return server;
  }
}
