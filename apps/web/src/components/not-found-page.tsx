'use client';

import type { PageContent } from '@canon/blocks';
import { BlockRenderer, PageStyles, type RenderMedia } from '@canon/ui-blocks';
import { useEffect, useState, type ReactNode } from 'react';

interface Custom404 {
  locale: string;
  content: PageContent;
  media: Record<string, RenderMedia>;
  facts: Record<string, string>;
}

/** Shows the site's own /404 page when it has one; the default message until then (or otherwise). */
export function SiteNotFoundPage({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Custom404 | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/not-found')
      .then((r) => (r.ok ? (r.json() as Promise<Custom404>) : null))
      .then((p) => live && p && setPage(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!page) return <>{children}</>;
  return (
    <main lang={page.locale}>
      <PageStyles root={page.content.root} />
      <BlockRenderer node={page.content.root} ctx={{ media: page.media, facts: page.facts, draft: false }} isRoot />
    </main>
  );
}
