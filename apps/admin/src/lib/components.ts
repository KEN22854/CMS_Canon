import type { BlockNode } from '@canon/blocks';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './api';
import { useTenantId } from './queries';

/** A site's global component (symbol), as the API returns it. */
export interface SiteComponent {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  tree: BlockNode;
  version: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
}

export const componentsKey = (tid: string | null | undefined, siteId: string) => ['components', tid, siteId] as const;

export function useComponents(siteId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: componentsKey(tid, siteId), queryFn: () => api<SiteComponent[]>(`/sites/${siteId}/components`), enabled: Boolean(tid && siteId) });
}

/** Working copies by id, for drawing instances on the canvas. */
export function useComponentTrees(siteId: string): Record<string, BlockNode> {
  const q = useComponents(siteId);
  return useMemo(() => Object.fromEntries((q.data ?? []).map((c) => [c.id, c.tree])), [q.data]);
}
