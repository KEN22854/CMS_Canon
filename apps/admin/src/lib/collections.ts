import type { CollectionAiSettings, CollectionSettings, EntryData, FieldDef } from '@canon/fields';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { PageStatus } from './content';
import { useTenantId } from './queries';

export interface Collection {
  id: string;
  siteId: string;
  name: string;
  slug: string;
  description: string | null;
  fields: FieldDef[];
  settings: CollectionSettings;
  aiSettings: CollectionAiSettings;
  isSingleton: boolean;
  entryCount?: number;
  updatedAt: string;
}

export interface DuplicateHit {
  id: string;
  title: string;
  slug: string;
  score: number;
  method: 'content' | 'title' | 'semantic';
}

export interface EntrySummary {
  id: string;
  slug: string;
  title: string;
  status: PageStatus;
  locale: string;
  tags: string[];
  summary: string | null;
  qualityScore: number | null;
  qualityIssues: string[];
  version: number;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  createdById: string | null;
  updatedAt: string;
}

export interface EntryDetail extends EntrySummary {
  collectionId: string;
  data: EntryData;
  aiMeta: {
    quality?: { score?: number; completeness?: number; missing?: string[]; issues?: string[]; model?: string };
    tags?: { ai: string[]; model?: string };
    duplicates?: DuplicateHit[];
    semanticIndex?: boolean;
    enrichedAt?: string;
    lastError?: string;
  };
  related: Record<string, { id: string; title: string; slug: string; collectionId: string; status: PageStatus }>;
  referencedBy: { field: string; entryId: string; title: string; collectionId: string; collectionName: string }[];
  versionCount: number;
}

export interface EntryList {
  items: EntrySummary[];
  total: number;
  tags: { tag: string; count: number }[];
}

export interface EntryQuery {
  q?: string;
  tag?: string;
  status?: string;
  locale?: string;
  sort?: 'updated' | 'created' | 'title' | 'quality';
  order?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export const collectionsKey = (tid: string | null, siteId: string) => ['collections', tid, siteId];

export function useCollections(siteId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: collectionsKey(tid, siteId), queryFn: () => api<Collection[]>(`/sites/${siteId}/collections`), enabled: Boolean(tid) });
}

export function useCollection(siteId: string, collectionId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['collection', tid, collectionId], queryFn: () => api<Collection>(`/sites/${siteId}/collections/${collectionId}`), enabled: Boolean(tid && collectionId) });
}

export function entriesPath(siteId: string, collectionId: string) {
  return `/sites/${siteId}/collections/${collectionId}/entries`;
}

export function useEntries(siteId: string, collectionId: string, q: EntryQuery) {
  const tid = useTenantId();
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  return useQuery({
    queryKey: ['entries', tid, collectionId, params.toString()],
    queryFn: () => api<EntryList>(`${entriesPath(siteId, collectionId)}?${params}`),
    enabled: Boolean(tid && collectionId),
    placeholderData: keepPreviousData,
  });
}

export function useEntry(siteId: string, collectionId: string, entryId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['entry', tid, entryId], queryFn: () => api<EntryDetail>(`${entriesPath(siteId, collectionId)}/${entryId}`), enabled: Boolean(tid && entryId), staleTime: Infinity });
}

export function qualityTone(score: number | null): string {
  if (score === null) return 'border-border text-muted-foreground';
  if (score >= 75) return 'border-success/40 text-success';
  if (score >= 50) return 'border-warning/40 text-warning';
  return 'border-destructive/40 text-destructive';
}
