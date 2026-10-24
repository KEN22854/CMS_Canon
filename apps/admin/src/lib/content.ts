'use client';

import type { PageContent } from '@canon/blocks';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTenantId } from './queries';

export interface Site {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  domain: string | null;
  internalDomain: string;
  url: string;
  defaultLocale: string;
  locales: string[];
  theme: { colors?: Record<string, string>; font?: string; radius?: string; mode?: string };
  seoDefaults: { titleTemplate?: string; description?: string };
  aiSettings: { brandVoice?: string; glossary?: ({ term: string; translations?: Record<string, string> } & Record<string, unknown>)[]; forbiddenTopics?: string[] };
  pageCount?: number;
  isPublished: boolean;
}

export type PageStatus = 'DRAFT' | 'IN_REVIEW' | 'SCHEDULED' | 'PUBLISHED' | 'ARCHIVED';

export interface PageSummary {
  id: string;
  siteId: string;
  parentId: string | null;
  title: string;
  slug: string;
  fullPath: string;
  locale: string;
  status: PageStatus;
  version: number;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
  translationGroupId: string | null;
  aiGenerated: boolean;
  updatedAt: string;
  publishedAt: string | null;
  scheduledAt: string | null;
  createdById: string | null;
  updatedById: string | null;
}

export interface PageDetail extends PageSummary {
  description: string | null;
  content: PageContent;
  seo: { title?: string; description?: string; noindex?: boolean };
  translations: { id: string; locale: string; fullPath: string; status: PageStatus }[];
  schedule: { id: string; at: string; action: 'PUBLISH' | 'UNPUBLISH' } | null;
}

export interface MediaItem {
  id: string;
  status: 'PENDING_UPLOAD' | 'PROCESSING' | 'READY' | 'FAILED';
  originalName: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbnailUrl: string | null;
  alt: string | null;
  altGenerated: boolean;
  caption: string | null;
  title: string | null;
  folder: string;
  tags: string[];
  dominantColor: string | null;
  variants: { thumb?: { url: string }; sources: { url: string; width: number; height: number; format: 'webp' | 'avif' }[] } | null;
  createdAt: string;
}

export function useSites() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['sites', tid], queryFn: () => api<Site[]>('/sites'), enabled: Boolean(tid) });
}

export function useSite(siteId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['site', tid, siteId], queryFn: () => api<Site>(`/sites/${siteId}`), enabled: Boolean(tid && siteId) });
}

export function usePages(siteId: string) {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['pages', tid, siteId],
    queryFn: () => api<{ items: PageSummary[] }>(`/sites/${siteId}/pages?limit=200`).then((r) => r.items),
    enabled: Boolean(tid && siteId),
  });
}

export function usePage(siteId: string, pageId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['page', tid, pageId], queryFn: () => api<PageDetail>(`/sites/${siteId}/pages/${pageId}`), enabled: Boolean(tid && pageId), staleTime: Infinity });
}

export function useMedia(siteId: string, q = '') {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['media', tid, siteId, q],
    queryFn: () => api<{ items: MediaItem[] }>(`/sites/${siteId}/media?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
    enabled: Boolean(tid && siteId),
  });
}

export async function uploadMedia(siteId: string, file: File, folder = '/'): Promise<MediaItem & { duplicate: boolean }> {
  const form = new FormData();
  form.set('file', file);
  form.set('folder', folder);
  return api(`/sites/${siteId}/media/upload`, { form });
}

export const STATUS_STYLE: Record<PageStatus, string> = {
  DRAFT: 'border-border text-muted-foreground',
  IN_REVIEW: 'border-warning/40 text-warning',
  SCHEDULED: 'border-primary/40 text-primary',
  PUBLISHED: 'border-success/40 text-success',
  ARCHIVED: 'border-border text-muted-foreground line-through',
};
