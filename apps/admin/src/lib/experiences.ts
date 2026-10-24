import type { BlockPatch, SegmentRules } from '@canon/edge';
export { SEGMENT_ATTRIBUTES, SEGMENT_OPERATORS, type SegmentCondition, type SegmentRules } from '@canon/edge';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTenantId } from './queries';

export interface Totals {
  views: number;
  visitors: number;
  sessions: number;
  bounceRate: number;
  avgEngagedSec: number;
  conversions: number;
  conversionRate: number;
}

export type Dimension = 'referrer' | 'country' | 'device' | 'browser' | 'os' | 'utm_source';

export interface Report {
  from: string;
  to: string;
  totals: Totals;
  previous: Totals;
  change: Record<keyof Totals, number | null>;
  series: { day: string; views: number; visitors: number; conversions: number }[];
  pages: { path: string; title: string | null; views: number; visitors: number; bounceRate: number; avgEngagedSec: number; conversions: number }[];
  dims: Record<Dimension, { value: string; views: number; visitors: number; conversions: number }[]>;
}

export type Severity = 'positive' | 'warning' | 'info';
export interface Insights {
  summary: string;
  insights: { title: string; detail: string; severity: Severity; path?: string }[];
  recommendations: { title: string; detail: string; action: 'ab_test' | 'personalize' | 'content' | 'seo' | 'none'; path?: string }[];
  generatedBy: 'ai' | 'rules';
  ai?: { model: string; costUsd: number };
}

export interface Variant {
  id: string;
  name: string;
  weight: number;
  patch: BlockPatch;
}

export type Verdict = 'collecting' | 'winner' | 'control_wins' | 'no_difference' | 'inconclusive';

export interface VariantStats {
  id: string;
  name: string;
  exposures: number;
  conversions: number;
  isControl: boolean;
  rate: number;
  ci95: [number, number];
  uplift: number | null;
  pValue: number | null;
  probBeatControl: number | null;
}

export interface Analysis {
  variants: VariantStats[];
  requiredPerVariant: number;
  progress: number;
  verdict: Verdict;
  leaderId: string | null;
}

export interface Recommendation {
  decision: 'declare_winner' | 'keep_running' | 'stop_no_effect' | 'stop_control_wins';
  winnerVariantId: string | null;
  reasoning: string;
  nextSteps: string[];
  generatedBy: 'ai' | 'rules';
  overridden?: string;
  at: string;
}

export interface Experiment {
  id: string;
  pageId: string;
  name: string;
  status: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED';
  goalMetric: string;
  trafficAllocation: number;
  variants: Variant[];
  startedAt: string | null;
  endedAt: string | null;
  winnerVariantId: string | null;
  aiRecommendation: Recommendation | null;
  createdAt: string;
  page: { id: string; title: string; fullPath: string; locale: string };
}

export interface ExperimentSummary extends Experiment {
  results: { verdict: Verdict; progress: number; leaderId: string | null; exposures: number } | null;
}

export interface ExperimentDetail extends Experiment {
  results: Analysis;
}

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  aiGenerated: boolean;
  personalizations: number;
  updatedAt: string;
}

export interface PagePersonalization {
  id: string;
  segment: { id: string; name: string };
  priority: number;
  status: 'ACTIVE' | 'PAUSED';
  patch: BlockPatch;
  updatedAt: string;
}

export const GOALS = ['cta_click', 'signup', 'purchase', 'contact', 'download'];

export const VERDICT: Record<Verdict, { label: string; className: string }> = {
  collecting: { label: 'Collecting data', className: 'border-muted-foreground/30 text-muted-foreground' },
  winner: { label: 'Winner found', className: 'border-success/40 text-success' },
  control_wins: { label: 'Original wins', className: 'border-warning/40 text-warning' },
  no_difference: { label: 'No difference', className: 'border-muted-foreground/30 text-muted-foreground' },
  inconclusive: { label: 'Inconclusive', className: 'border-warning/40 text-warning' },
};

export function useExperiments(siteId: string, pageId?: string) {
  const tid = useTenantId();
  return useQuery({
    queryKey: ['experiments', tid, siteId, pageId ?? null],
    queryFn: () => api<ExperimentSummary[]>(`/sites/${siteId}/experiments${pageId ? `?pageId=${pageId}` : ''}`),
    enabled: Boolean(tid),
  });
}

export function useExperiment(id: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['experiment', tid, id], queryFn: () => api<ExperimentDetail>(`/experiments/${id}`), enabled: Boolean(tid), refetchInterval: 30_000 });
}

export function useSegments(siteId: string) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['segments', tid, siteId], queryFn: () => api<Segment[]>(`/sites/${siteId}/segments`), enabled: Boolean(tid) });
}

export const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const signedPct = (x: number | null) => (x === null ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
