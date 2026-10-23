import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTenantId } from './queries';

export type ValueType = 'TEXT' | 'NUMBER' | 'MONEY' | 'PERCENT' | 'DATE' | 'BOOLEAN' | 'URL' | 'LIST';
export type MentionState = 'IN_SYNC' | 'STALE' | 'CONFLICT' | 'DISMISSED';

export interface Fact {
  id: string;
  key: string;
  siteId: string | null;
  subject: { id: string; name: string; type: string };
  predicate: string;
  valueType: ValueType;
  value: Record<string, unknown>;
  displayValue: string;
  unit: string | null;
  status: 'ACTIVE' | 'DISPUTED' | 'DEPRECATED';
  version: number;
  validFrom: string;
  expiresAt: string | null;
  updatedAt: string;
  mentions: { total: number; inSync: number; stale: number; conflict: number; dismissed: number };
}

export interface EntityInfo {
  type: 'PAGE' | 'ENTRY';
  id: string;
  title: string;
  path: string;
  siteId: string;
  locale: string;
  status: string;
  collectionId: string | null;
  collectionName: string | null;
}

export interface Mention {
  id: string;
  kind: 'BOUND' | 'DETECTED';
  state: MentionState;
  surfaceText: string;
  blockId: string | null;
  fieldPath: string;
  locale: string;
  confidence: number;
  factVersionSeen: number;
}

export interface Impact {
  totals: { mentions: number; entities: number; bound: number; detected: number; stale: number; conflicts: number; locales: string[] };
  entities: { entity: EntityInfo; mentions: Mention[] }[];
}

export interface ConflictItem {
  id: string;
  state: MentionState;
  surfaceText: string;
  blockId: string | null;
  fieldPath: string;
  locale: string;
  confidence: number;
  fact: { id: string; key: string; displayValue: string; version: number };
  entity: EntityInfo;
}

export interface SpanResult {
  mentionId: string;
  blockId: string | null;
  fieldPath: string;
  fieldLabel: string;
  locale: string;
  agent: 'Copywriter' | 'Translator';
  before: string;
  after: string | null;
  context: { before: string; after: string };
  explanation: string | null;
  verdict: 'pass' | 'uncertain' | 'fail' | 'escalated';
  issues: string[];
  applied: boolean;
}

export interface BranchSummary {
  proposed?: number;
  escalated?: number;
  failed?: number;
  bound?: number;
  entities?: number;
  from?: string;
  to?: string;
  factKey?: string;
  costUsd?: number;
  tokens?: number;
  error?: string;
}

export interface Branch {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  status: 'OPEN' | 'IN_REVIEW' | 'MERGED' | 'CLOSED' | 'CONFLICTED';
  summary: BranchSummary | null;
  run: { id: string; status: string; costUsd: number; totalTokens: number } | null;
  createdBy: string | null;
  mergedBy: string | null;
  mergedAt: string | null;
  createdAt: string;
  changes: {
    id: string;
    entityType: 'PAGE' | 'ENTRY';
    entityId: string;
    entity: EntityInfo | null;
    status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED';
    baseVersion: number;
    applicable: boolean;
    explanation: { title: string; path: string; locale: string; factKey: string; from: string; to: string; spans: SpanResult[] };
  }[];
}

export interface AgentStep {
  id: string;
  stepNumber: number;
  node: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  llmResponse: string | null;
  tokens: number;
  costUsd: number | string;
  durationMs: number;
}

export interface AgentRun {
  id: string;
  status: string;
  agent: { name: string; type: string };
  input: unknown;
  result: unknown;
  totalTokens: number;
  costUsd: number | string;
  steps: AgentStep[];
  children?: AgentRun[];
  createdAt: string;
  completedAt: string | null;
}

export function useFacts(siteId?: string, q?: string) {
  const tid = useTenantId();
  const params = new URLSearchParams({ ...(siteId ? { siteId } : {}), ...(q ? { q } : {}) });
  return useQuery({ queryKey: ['canon-facts', tid, siteId, q], queryFn: () => api<Fact[]>(`/canon/facts?${params}`), enabled: Boolean(tid) });
}

export function useFact(id: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['canon-fact', tid, id], queryFn: () => api<Fact>(`/canon/facts/${id}`), enabled: Boolean(tid && id) });
}

export function useImpact(id: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['canon-impact', tid, id], queryFn: () => api<Impact>(`/canon/facts/${id}/impact`), enabled: Boolean(tid && id) });
}

export function useConflicts(siteId?: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['canon-conflicts', tid, siteId], queryFn: () => api<ConflictItem[]>(`/canon/conflicts${siteId ? `?siteId=${siteId}` : ''}`), enabled: Boolean(tid) });
}

export function useBranch(id: string) {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['branch', tid, id],
    queryFn: () => api<Branch>(`/branches/${id}`),
    enabled: Boolean(tid && id),
    // The agent team works in the background: poll until it hands over to a human.
    refetchInterval: (q) => (q.state.data && (q.state.data.run?.status === 'QUEUED' || q.state.data.run?.status === 'RUNNING') ? 1_500 : false),
  });
}

export const STATE_STYLE: Record<MentionState, string> = {
  IN_SYNC: 'border-success/40 text-success',
  STALE: 'border-warning/40 text-warning',
  CONFLICT: 'border-destructive/40 text-destructive',
  DISMISSED: 'border-border text-muted-foreground',
};

export const VERDICT_STYLE: Record<SpanResult['verdict'], string> = {
  pass: 'border-success/40 text-success',
  uncertain: 'border-warning/40 text-warning',
  fail: 'border-destructive/40 text-destructive',
  escalated: 'border-warning/40 text-warning',
};

export function entityHref(e: EntityInfo): string {
  return e.type === 'PAGE' ? `/sites/${e.siteId}/pages/${e.id}` : `/sites/${e.siteId}/collections/${e.collectionId}/entries/${e.id}`;
}
