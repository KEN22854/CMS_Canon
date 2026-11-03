'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Bot, Braces, Monitor, Moon, Sun, Building2, Globe, Check, ChevronsUpDown, CreditCard, Fingerprint, KeyRound, LayoutDashboard, Loader2, LogOut, Plug, Plus, ScrollText, Shield, Sparkles, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, refreshSession } from '@/lib/api';
import { useAbility, useMe } from '@/lib/ability';
import { useAuth, type AuthPayload } from '@/lib/auth-store';
import { LOCALES, LOCALE_LABEL, useLocaleStore, useT, type Locale, type MessageKey } from '@/lib/i18n';
import { NEXT_THEME, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { NotificationBell } from './notification-bell';
import { Badge } from './ui';

/** Client-side gate: silent refresh from the httpOnly cookie, else redirect to sign-in. */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'unknown') void refreshSession();
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  return <>{children}</>;
}

const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL || 'https://github.com/KEN22854/CMS_Canon';

const NAV = [
  { href: '/', label: 'nav.dashboard', icon: LayoutDashboard, can: null },
  { href: '/sites', label: 'nav.sites', icon: Globe, can: ['read', 'Site'] },
  { href: '/canon', label: 'nav.canon', icon: Braces, can: ['read', 'Fact'] },
  { href: '/studio', label: 'nav.studio', icon: Bot, can: ['read', 'AiPrompt'] },
  { href: '/settings/members', label: 'nav.members', icon: Users, can: ['read', 'Member'] },
  { href: '/settings/ai-usage', label: 'nav.aiUsage', icon: Sparkles, can: ['read', 'AiUsage'] },
  { href: '/settings/api-keys', label: 'nav.apiKeys', icon: KeyRound, can: ['read', 'ApiKey'] },
  { href: '/settings/integrations', label: 'nav.integrations', icon: Plug, can: ['manage', 'Plugin'] },
  { href: '/settings/billing', label: 'nav.billing', icon: CreditCard, can: ['read', 'Tenant'] },
  { href: '/settings/audit', label: 'nav.audit', icon: ScrollText, can: ['read', 'AuditLog'] },
  { href: '/settings/sso', label: 'nav.sso', icon: Fingerprint, can: ['update', 'Tenant'] },
  { href: '/settings/security', label: 'nav.security', icon: Shield, can: null },
] as const satisfies readonly { href: string; label: MessageKey; icon: unknown; can: unknown }[];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ability = useAbility();
  const t = useT();
  // The page and component builders are full-bleed workspaces with their own toolbar and a way back.
  if (/^\/sites\/[^/]+\/(pages|components)\/[^/]+/.test(pathname)) return <main className="min-w-0">{children}</main>;
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground" aria-hidden>
            C
          </span>
          <span className="flex-1 font-semibold">Canon</span>
          <NotificationBell />
        </div>
        <div className="px-3">
          <TenantSwitcher />
        </div>
        <nav className="mt-4 flex flex-1 flex-col gap-0.5 px-3" aria-label={t('nav.main')}>
          {NAV.filter((n) => !n.can || ability.can(n.can[0], n.can[1])).map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted', active && 'bg-muted font-medium')}
              >
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {t(label)}
              </Link>
            );
          })}
        </nav>
        {/* AGPL-3.0 §13: users of a network deployment get a way to the corresponding source. */}
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="px-4 pb-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t('shell.source')}
        </a>
        <UserMenu />
      </aside>
      <main className="min-w-0 flex-1">
        {/* Mobile: the sidebar collapses into a scrollable top bar. */}
        <div className="space-y-2 border-b px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <TenantSwitcher />
            </div>
            <NotificationBell />
          </div>
          <nav className="-mx-1 flex gap-1 overflow-x-auto" aria-label={t('nav.main')}>
            {NAV.filter((n) => !n.can || ability.can(n.can[0], n.can[1])).map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  'shrink-0 rounded-md px-2 py-1 text-sm hover:bg-muted',
                  (href === '/' ? pathname === '/' : pathname.startsWith(href)) && 'bg-muted font-medium',
                )}
              >
                {t(label)}
              </Link>
            ))}
          </nav>
        </div>
        {/* The page builder is a full-bleed workspace; everything else reads best in a column. */}
        {/^\/sites\/[^/]+\/pages\/[^/]+/.test(pathname) ? children : <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">{children}</div>}
      </main>
    </div>
  );
}

function TenantSwitcher() {
  const { data: me } = useMe();
  const tenant = useAuth((s) => s.tenant);
  const setSession = useAuth((s) => s.setSession);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const switchTo = async (tenantId: string) => {
    setSwitching(tenantId);
    try {
      setSession(await api<AuthPayload>('/auth/switch-tenant', { body: { tenantId } }));
      // Everything cached belongs to the previous tenant.
      queryClient.clear();
      setOpen(false);
      router.push('/');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-sm hover:bg-muted"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{tenant?.name ?? t('shell.noWorkspace')}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div role="listbox" className="absolute z-20 mt-1 w-full rounded-md border bg-card p-1 shadow-lg">
          {me?.tenants.map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === tenant?.id}
              type="button"
              onClick={() => t.id !== tenant?.id && void switchTo(t.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <Badge className="text-[10px]">{t.plan}</Badge>
              {switching === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : t.id === tenant?.id ? <Check className="h-3 w-3" /> : null}
            </button>
          ))}
          <Link
            href="/workspaces/new"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 border-t px-2 pb-1 pt-2 text-sm text-primary"
          >
            <Plus className="h-4 w-4" aria-hidden /> {t('shell.newWorkspace')}
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const user = useAuth((s) => s.user);
  const tenant = useAuth((s) => s.tenant);
  const clear = useAuth((s) => s.clear);
  const patchUser = useAuth((s) => s.patchUser);
  const router = useRouter();
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const theme = useTheme();
  const ThemeIcon = theme.choice === 'dark' ? Moon : theme.choice === 'light' ? Sun : Monitor;
  const themeLabel = t('theme.label', { name: t(`theme.${theme.choice}`) });
  const changeLocale = (l: Locale) => {
    setLocale(l);
    // Saved to the profile so other devices follow the choice.
    void api('/auth/me', { method: 'PATCH', body: { locale: l } })
      .then(() => patchUser({ locale: l }))
      .catch(() => undefined);
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    clear();
    router.replace('/login');
  };
  return (
    <div className="flex items-center gap-2 border-t px-3 py-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-medium text-primary" aria-hidden>
        {user?.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{user?.name}</p>
        <p className="truncate text-xs text-muted-foreground">{tenant?.role.toLowerCase() ?? user?.email}</p>
      </div>
      <select
        aria-label={t('common.language')}
        title={t('common.language')}
        value={locale}
        onChange={(e) => changeLocale(e.target.value as Locale)}
        className="rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground hover:bg-muted"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} title={LOCALE_LABEL[l]}>
            {l.toUpperCase()}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => theme.setChoice(NEXT_THEME[theme.choice])} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label={themeLabel} title={themeLabel}>
        <ThemeIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={logout}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
        aria-label={t('shell.signOut')}
        title={t('shell.signOut')}
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
