'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAbility } from '@/lib/ability';
import { useSite } from '@/lib/content';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export default function SiteLayout({ children }: { children: ReactNode }) {
  const { siteId } = useParams<{ siteId: string }>();
  const pathname = usePathname();
  const site = useSite(siteId);
  const ability = useAbility();
  const t = useT();
  // The page editor takes the full width; it has its own toolbar.
  if (/\/(pages|components)\/[^/]+$/.test(pathname)) return <>{children}</>;

  const tabs = [
    { href: `/sites/${siteId}/pages`, label: t('site.pages') },
    { href: `/sites/${siteId}/components`, label: t('component.listTitle') },
    { href: `/sites/${siteId}/collections`, label: t('site.collections') },
    ...(ability.can('read', 'Order') ? [{ href: `/sites/${siteId}/orders`, label: t('site.orders') }] : []),
    ...(ability.can('read', 'Contact') ? [{ href: `/sites/${siteId}/contacts`, label: t('site.contacts') }] : []),
    ...(ability.can('read', 'Automation') ? [{ href: `/sites/${siteId}/automations`, label: t('site.automations') }] : []),
    { href: `/sites/${siteId}/reviews`, label: t('site.reviews') },
    { href: `/sites/${siteId}/media`, label: t('site.media') },
    ...(ability.can('read', 'Form') ? [{ href: `/sites/${siteId}/forms`, label: t('site.forms') }] : []),
    { href: `/sites/${siteId}/seo`, label: t('site.seo') },
    { href: `/sites/${siteId}/releases`, label: t('site.releases') },
    ...(ability.can('create', 'Page') ? [{ href: `/sites/${siteId}/migration`, label: t('site.migration') }] : []),
    { href: `/sites/${siteId}/search`, label: t('site.search') },
    ...(ability.can('read', 'Analytics')
      ? [{ href: `/sites/${siteId}/analytics`, label: t('site.analytics') }]
      : []),
    ...(ability.can('read', 'AbTest')
      ? [{ href: `/sites/${siteId}/experiments`, label: t('site.experiments') }]
      : []),
    { href: `/sites/${siteId}/audiences`, label: t('site.audiences') },
    ...(ability.can('update', 'Site')
      ? [{ href: `/sites/${siteId}/settings`, label: t('site.settings') }]
      : []),
  ];
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/sites" className="text-xs text-muted-foreground hover:underline">
            {t('nav.sites')}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{site.data?.name ?? '…'}</h1>
        </div>
        {site.data && (
          <a
            href={site.data.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {site.data.domainStatus === 'VERIFIED' && site.data.domain
              ? site.data.domain
              : site.data.internalDomain}{' '}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
      <nav className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b px-1 [scrollbar-width:thin]" aria-label={t('site.tabs')}>
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={pathname.startsWith(t.href) ? 'page' : undefined}
            className={cn(
              '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
              pathname.startsWith(t.href)
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
