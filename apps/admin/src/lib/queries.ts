'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth, type MemberRole } from './auth-store';

export interface QuotaUsage {
  plan: string;
  usage: { members: number; pendingInvites: number; sites: number; pages: number; storageMb: number; aiTokens: number; aiCostUsd: number; aiRequests: number };
  limits: { members: number | null; sites: number | null; pages: number | null; storageMb: number | null; aiTokensPerMonth: number | null; aiBudgetUsd: number | null };
}

export interface Bucket {
  key: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface AiUsage {
  period: { from: string; to: string };
  totals: { requests: number; tokens: number; costUsd: number; cacheHits: number; cacheHitRate: number; failed: number; degraded: number; blocked: number };
  byFeature: Bucket[];
  byModel: Bucket[];
  byDay: Bucket[];
  month: { spentUsd: number; tokens: number; forecastUsd: number; budgetUsd: number | null; budgetUsedPct: number | null; forecastOverBudget: boolean };
  limits: { plan: string; tokensPerMonth: number | null; requestsPerMin: number; requestsPerUserPerMin: number; concurrentRequests: number; modelTiers: string[]; hardLimit: boolean };
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  joinedAt: string | null;
  lastLoginAt: string | null;
  twoFactorEnabled: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
  createdAt: string;
}

/** Every tenant-scoped query is keyed by tenant id, so a tenant switch can never show stale data. */
function useTenantId(): string {
  return useAuth((s) => s.tenant?.id) ?? '';
}

export function useQuota() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['quota', tid], queryFn: () => api<QuotaUsage>(`/tenants/${tid}/quota`), enabled: Boolean(tid) });
}

export function useAiUsage() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['ai-usage', tid], queryFn: () => api<AiUsage>('/ai/usage'), enabled: Boolean(tid) });
}

export function useMembers() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['members', tid], queryFn: () => api<Member[]>(`/tenants/${tid}/members`), enabled: Boolean(tid) });
}

export function useInvitations(enabled: boolean) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['invitations', tid], queryFn: () => api<Invitation[]>(`/tenants/${tid}/invitations`), enabled: Boolean(tid) && enabled });
}

export { useTenantId };
