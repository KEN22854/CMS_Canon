'use client';

import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAbility } from '@/lib/ability';
import { useSite } from '@/lib/content';
import { cn } from '@/lib/utils';

export default function SiteLayout({ children }: { children: ReactNode }) {
  const { siteId } = useParams<{ siteId: string }>();
  const pathname = usePathname();
  const site = useSite(siteId);
  const ability = useAbility();
  // The page editor takes the full width; it has its own toolbar.
  if (/\/pages\/[^/]+$/.test(pathname)) return <>{children}</>;

  const tabs = [
    { href: `/sites/${siteId}/pages`, label: 'Pages' },
    { href: `/sites/${siteId}/collections`, label: 'Collections' },
    { href: `/sites/${siteId}/media`, label: 'Media' },
    { href: `/sites/${siteId}/search`, label: 'Search & answers' },
    ...(ability.can('read', 'Analytics') ? [{ href: `/sites/${siteId}/analytics`, label: 'Analytics' }] : []),
    ...(ability.can('read', 'AbTest') ? [{ href: `/sites/${siteId}/experiments`, label: 'Experiments' }] : []),
    { href: `/sites/${siteId}/audiences`, label: 'Audiences' },
    ...(ability.can('update', 'Site') ? [{ href: `/sites/${siteId}/settings`, label: 'Settings' }] : []),
  ];
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/sites" className="text-xs text-muted-foreground hover:underline">
            Sites
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{site.data?.name ?? '…'}</h1>
        </div>
        {site.data && (
          <a href={site.data.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-primary hover:underline">
            {site.data.domain ?? site.data.internalDomain} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </div>
      <nav className="mb-6 flex gap-1 border-b" aria-label="Site">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={pathname.startsWith(t.href) ? 'page' : undefined}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', pathname.startsWith(t.href) ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
