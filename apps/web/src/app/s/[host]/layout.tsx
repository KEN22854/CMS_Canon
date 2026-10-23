import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { siteThemeStyle } from '@canon/ui-blocks';
import { resolveSite } from '@/lib/delivery';

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ host: string }> }) {
  const { host } = await params;
  const site = await resolveSite(decodeURIComponent(host));
  if (!site) notFound();
  return (
    <div style={siteThemeStyle(site.theme)} className="min-h-screen bg-site-bg font-site text-site-fg">
      {children}
    </div>
  );
}
