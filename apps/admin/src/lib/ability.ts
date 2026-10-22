'use client';

import { createMongoAbility, type MongoAbility } from '@casl/ability';
import { unpackRules, type PackRule } from '@casl/ability/extra';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth, type ActiveTenant, type SessionUser } from './auth-store';

export interface MeResponse {
  user: SessionUser;
  tenant: ActiveTenant | null;
  tenants: (Omit<ActiveTenant, 'role'> & { role: ActiveTenant['role'] })[];
  rules: PackRule<never>[];
}

/**
 * Same CASL rules the API enforces, used only to hide controls the user cannot use.
 * Security never depends on this — the API re-checks every request.
 */
export function useMe() {
  const token = useAuth((s) => s.accessToken);
  const tenantId = useAuth((s) => s.tenant?.id);
  return useQuery({
    queryKey: ['me', tenantId],
    queryFn: () => api<MeResponse>('/auth/me'),
    enabled: Boolean(token),
    staleTime: 60_000,
  });
}

export function useAbility(): MongoAbility {
  const { data } = useMe();
  return createMongoAbility(data ? unpackRules(data.rules) : []);
}
