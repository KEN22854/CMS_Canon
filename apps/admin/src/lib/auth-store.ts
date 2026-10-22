import { create } from 'zustand';

export type MemberRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'AUTHOR' | 'VIEWER';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  locale: string;
  role: string;
  twoFactorEnabled: boolean;
  emailVerified: boolean;
}

export interface ActiveTenant {
  id: string;
  name: string;
  slug: string;
  plan: 'FREE' | 'PRO' | 'BUSINESS' | 'ENTERPRISE';
  role: MemberRole;
}

export interface AuthPayload {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  tenant: ActiveTenant | null;
}

interface AuthState {
  status: 'unknown' | 'authenticated' | 'anonymous';
  accessToken: string | null;
  user: SessionUser | null;
  tenant: ActiveTenant | null;
  setSession: (p: AuthPayload) => void;
  patchUser: (u: Partial<SessionUser>) => void;
  clear: () => void;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useAuth = create<AuthState>((set) => ({
  status: 'unknown',
  accessToken: null,
  user: null,
  tenant: null,
  setSession: (p) => {
    set({ status: 'authenticated', accessToken: p.accessToken, user: p.user, tenant: p.tenant });
    // Refresh a minute before expiry so users never see a 401 round-trip mid-edit.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void import('./api').then((m) => m.refreshSession());
    }, Math.max((p.expiresIn - 60) * 1000, 5_000));
  },
  patchUser: (u) => set((s) => (s.user ? { user: { ...s.user, ...u } } : {})),
  clear: () => {
    clearTimeout(refreshTimer);
    set({ status: 'anonymous', accessToken: null, user: null, tenant: null });
  },
}));
