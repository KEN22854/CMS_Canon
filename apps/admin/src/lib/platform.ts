import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useTenantId } from './queries';

export type Plan = 'FREE' | 'PRO' | 'BUSINESS' | 'ENTERPRISE';

export interface PlanLimits {
  sites: number | null;
  pages: number | null;
  collections: number | null;
  entries: number | null;
  storageMb: number | null;
  members: number | null;
  apiCallsPerMonth: number | null;
  aiTokensPerMonth: number | null;
  maxAgents: number;
  aiBudgetUsd: number | null;
  aiHardLimit: boolean;
}

export interface BillingOverview {
  plan: Plan;
  billingEnabled: boolean;
  usage: { members: number; sites: number; pages: number; collections: number; entries: number; storageMb: number; aiTokens: number; aiCostUsd: number; aiRequests: number };
  limits: PlanLimits;
  subscription: { plan: Plan; status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED' | 'INCOMPLETE'; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  plans: { plan: Plan; priceUsd: number | null; limits: PlanLimits; purchasable: boolean }[];
}

export interface AuditItem {
  id: string;
  createdAt: string;
  actorType: string;
  userId: string | null;
  user: { id: string; name: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  changes: unknown;
  ipAddress: string | null;
  aiInvolved: boolean;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  siteId: string | null;
  isActive: boolean;
  failureCount: number;
  disabledReason: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface Delivery {
  id: string;
  event: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'DEAD';
  attempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  nextRetryAt: string | null;
}

export interface PluginSetting {
  key: string;
  label: string;
  kind: 'text' | 'url' | 'secret' | 'select' | 'toggle';
  required: boolean;
  options?: string[];
  help?: string;
  placeholder?: string;
}

export interface PluginListing {
  id: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  homepage: string | null;
  category: string;
  icon: string | null;
  permissions: string[];
  events: string[];
  settings: PluginSetting[];
  blocks: { key: string; name: string; description: string }[];
  private: boolean;
  installation: {
    id: string;
    isActive: boolean;
    version: string;
    settings: Record<string, string | boolean>;
    grantedPermissions: string[];
    needsConsent: boolean;
    updateAvailable: boolean;
    installedAt: string;
  } | null;
}

export interface SsoView {
  connection: {
    id: string;
    name: string;
    domains: string[];
    verifiedDomains: string[];
    idpEntityId: string;
    idpSsoUrl: string;
    enforced: boolean;
    jitProvisioning: boolean;
    defaultRole: 'ADMIN' | 'EDITOR' | 'AUTHOR' | 'VIEWER';
    isActive: boolean;
    lastLoginAt: string | null;
    certificateFingerprint: string | null;
  } | null;
  serviceProvider: { entityId: string; acsUrl: string; metadataUrl: string; loginUrl: string } | null;
  domains: { domain: string; verified: boolean; record: { type: string; name: string; value: string } }[];
}

/** Human labels for API-key scopes, shown on consent screens. */
export const PERMISSION_LABEL: Record<string, string> = {
  'content:read': 'Read sites, pages, collections and entries',
  'content:write': 'Create and edit drafts',
  'content:publish': 'Publish pages and entries',
  'media:write': 'Upload media',
  'ai:invoke': 'Use AI on your behalf (billed to this workspace)',
  'ai:usage:read': 'Read AI usage',
  'canon:read': 'Read Canon facts and branches',
  'canon:write': 'Change Canon facts and open branches',
  'analytics:read': 'Read analytics',
};

export function useBilling() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['billing', tid], queryFn: () => api<BillingOverview>('/billing'), enabled: Boolean(tid) });
}

export function useWebhooks() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['webhooks', tid], queryFn: () => api<Webhook[]>('/webhooks'), enabled: Boolean(tid) });
}

export function usePlugins() {
  const tid = useTenantId();
  return useQuery({ queryKey: ['plugins', tid], queryFn: () => api<PluginListing[]>('/plugins'), enabled: Boolean(tid) });
}

export function useSso(enabled = true) {
  const tid = useTenantId();
  return useQuery({ queryKey: ['sso', tid], queryFn: () => api<SsoView>('/sso'), enabled: Boolean(tid) && enabled });
}
