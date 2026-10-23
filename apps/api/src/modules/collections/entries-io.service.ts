import { normalizeTag, parseCsv, rowsFromCsv, toCsv, validateEntryData, type CsvRow, type EntryData } from '@canon/fields';
import { Injectable } from '@nestjs/common';
import type { AppAbility } from '../../common/auth/abilities';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest } from '../../common/http/api-error';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { CollectionsService, type CollectionModel } from './collections.service';
import type { ImportQuery } from './collections.dto';
import { EntriesService } from './entries.service';

export const MAX_IMPORT_ROWS = 5_000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const EXPORT_PAGE = 500;
const MAX_EXPORT = 50_000;

export interface ImportReport {
  dryRun: boolean;
  rows: number;
  created: number;
  updated: number;
  published: number;
  errors: { line: number; slug?: string; issues: { field: string; message: string }[] }[];
  warnings: string[];
}

/**
 * CSV/JSON import and export. Import is row-by-row through EntriesService, so every rule that
 * guards the editor (validation, uniqueness, relations, plan limits, CAS) guards imports too; a
 * bad row is reported with its line number and never aborts the rest.
 */
@Injectable()
export class EntriesIoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionsService,
    private readonly entries: EntriesService,
    private readonly sites: SitesService,
  ) {}

  async export(tenantId: string, siteId: string, collectionId: string, q: { format: 'csv' | 'json'; locale?: string; status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' }) {
    const c = await this.collections.get(tenantId, siteId, collectionId);
    const db = this.prisma.forTenant({ tenantId });
    const rows: { slug: string; locale: string; status: string; tags: string[]; data: EntryData }[] = [];
    let cursor: string | undefined;
    // Keyset pagination keeps memory flat-ish and the transaction short per page.
    for (;;) {
      const page = await db.entry.findMany({
        where: { collectionId, deletedAt: null, ...(q.locale ? { locale: q.locale } : {}), ...(q.status ? { status: q.status } : {}) },
        orderBy: { id: 'asc' },
        take: EXPORT_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, slug: true, locale: true, status: true, tags: true, data: true },
      });
      rows.push(...page.map((e) => ({ slug: e.slug, locale: e.locale, status: e.status, tags: e.tags, data: e.data as EntryData })));
      if (page.length < EXPORT_PAGE || rows.length >= MAX_EXPORT) break;
      cursor = page.at(-1)!.id;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'json') {
      const body = JSON.stringify({ collection: { slug: c.row.slug, name: c.row.name, fields: c.fields }, exportedAt: new Date().toISOString(), entries: rows }, null, 2);
      return { filename: `${c.row.slug}-${stamp}.json`, contentType: 'application/json; charset=utf-8', body };
    }
    // BOM so Excel opens UTF-8 (Cyrillic, accents) correctly.
    return { filename: `${c.row.slug}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: `﻿${toCsv(c.fields, rows)}` };
  }

  async import(actor: TenantPrincipal, ability: AppAbility, siteId: string, collectionId: string, file: { buffer: Buffer; originalname: string; mimetype: string }, q: ImportQuery): Promise<ImportReport> {
    const c = await this.collections.get(actor.tenantId, siteId, collectionId);
    const site = await this.sites.get(actor.tenantId, siteId);
    if (file.buffer.length > MAX_IMPORT_BYTES) throw badRequest('FILE_TOO_LARGE', `Import files are limited to ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
    const format = q.format ?? (/\.json$/i.test(file.originalname) || file.mimetype.includes('json') ? 'json' : 'csv');
    const { rows, warnings } = this.parse(c, file.buffer.toString('utf8'), format);
    if (rows.length > MAX_IMPORT_ROWS) throw badRequest('TOO_MANY_ROWS', `Import at most ${MAX_IMPORT_ROWS} rows per file`, { rows: rows.length });

    const report: ImportReport = { dryRun: q.dryRun, rows: rows.length, created: 0, updated: 0, published: 0, errors: [], warnings };
    const slugCache = new Map<string, string | null>();
    const seen = new Set<string>();
    for (const row of rows) {
      const locale = row.locale ?? site.defaultLocale;
      const fail = (issues: { field: string; message: string }[]) => report.errors.push({ line: row.line, slug: row.slug, issues });
      if (!site.locales.includes(locale)) {
        fail([{ field: 'locale', message: `Site has no locale "${locale}"` }]);
        continue;
      }
      if (row.slug && seen.has(`${locale}:${row.slug}`)) {
        fail([{ field: 'slug', message: 'Duplicate slug in this file' }]);
        continue;
      }
      if (row.slug) seen.add(`${locale}:${row.slug}`);
      try {
        const existing = q.mode === 'upsert' && row.slug ? await this.prisma.forTenant({ tenantId: actor.tenantId }).entry.findFirst({ where: { collectionId, locale, slug: row.slug, deletedAt: null } }) : null;
        const resolved = await this.resolveRelationSlugs(actor.tenantId, c, row.data, locale, slugCache);
        // Upsert is a partial update: columns missing from the file (or empty cells) keep their values.
        const data = existing ? { ...(existing.data as EntryData), ...resolved } : resolved;
        const check = validateEntryData(c.fields, data, q.publish ? 'publish' : 'draft');
        if (!check.ok) {
          fail(check.issues);
          continue;
        }
        if (q.dryRun) {
          if (existing) report.updated++;
          else report.created++;
          continue;
        }
        const tags = row.tags.map(normalizeTag);
        const id = existing
          ? (await this.entries.update(actor, ability, siteId, collectionId, existing.id, { expectedVersion: existing.version, data: check.data, tags: tags.length ? tags : existing.tags }, { source: 'import' })).id
          : (await this.entries.create(actor, siteId, collectionId, { data: check.data, locale, tags, ...(row.slug ? { slug: row.slug } : {}) }, { source: 'import' })).id;
        if (existing) report.updated++;
        else report.created++;
        if (q.publish || row.status === 'PUBLISHED') {
          await this.entries.publish(actor, ability, siteId, collectionId, id, 'Imported');
          report.published++;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          const details = err.details as { issues?: { field: string; message: string }[] } | undefined;
          fail(details?.issues ?? [{ field: '', message: err.message }]);
          // Plan limits stop the import: every following row would fail the same way.
          if (err.code === 'QUOTA_EXCEEDED') break;
        } else throw err;
      }
    }
    return report;
  }

  private parse(c: CollectionModel, text: string, format: 'csv' | 'json'): { rows: CsvRow[]; warnings: string[] } {
    if (format === 'csv') {
      let table: string[][];
      try {
        table = parseCsv(text);
      } catch (err) {
        throw badRequest('INVALID_FILE', `CSV could not be parsed: ${(err as Error).message}`);
      }
      const { rows, unknownColumns } = rowsFromCsv(c.fields, table);
      return { rows, warnings: unknownColumns.length ? [`Ignored unknown columns: ${unknownColumns.join(', ')}`] : [] };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw badRequest('INVALID_FILE', 'File is not valid JSON');
    }
    // Accepts our export shape ({entries: [...]}) or a bare array of entries / of data objects.
    const list = Array.isArray(json) ? json : Array.isArray((json as { entries?: unknown }).entries) ? (json as { entries: unknown[] }).entries : null;
    if (!list) throw badRequest('INVALID_FILE', 'Expected an array of entries or {"entries": [...]}');
    const rows = list.map((raw, i): CsvRow => {
      const r = (raw ?? {}) as { slug?: unknown; locale?: unknown; status?: unknown; tags?: unknown; data?: unknown };
      const hasEnvelope = r.data && typeof r.data === 'object';
      return {
        line: i + 1,
        slug: typeof r.slug === 'string' ? r.slug : undefined,
        locale: typeof r.locale === 'string' ? r.locale : undefined,
        status: typeof r.status === 'string' ? r.status : undefined,
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
        data: (hasEnvelope ? r.data : raw) as EntryData,
      };
    });
    return { rows, warnings: [] };
  }

  /** Relation cells may hold target slugs (human-friendly CSV) or ids (round-tripped exports). */
  private async resolveRelationSlugs(tenantId: string, c: CollectionModel, data: EntryData, locale: string, cache: Map<string, string | null>): Promise<EntryData> {
    const out = { ...data };
    for (const f of c.fields.filter((x) => x.type === 'relation')) {
      const v = out[f.name];
      if (v === undefined) continue;
      const target = f.relation!.collectionId;
      const resolve = async (ref: unknown) => {
        if (typeof ref !== 'string') return ref;
        const key = `${target}:${locale}:${ref}`;
        if (!cache.has(key)) {
          const hit = await this.prisma.forTenant({ tenantId }).entry.findFirst({ where: { collectionId: target, deletedAt: null, OR: [{ id: ref }, { slug: ref, locale }] }, select: { id: true } });
          cache.set(key, hit?.id ?? null);
        }
        return cache.get(key) ?? ref;
      };
      out[f.name] = Array.isArray(v) ? await Promise.all(v.map(resolve)) : await resolve(v);
    }
    return out;
  }
}
