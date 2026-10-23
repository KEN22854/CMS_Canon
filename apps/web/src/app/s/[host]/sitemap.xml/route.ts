import { listPages, localizedHref, resolveSite } from '@/lib/delivery';

/** Rendered per request (hosts are unknown at build time); the delivery fetches underneath are ISR-cached by tag. */
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** Per-host sitemap with xhtml:link hreflang alternates for translated pages. */
export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  const site = await resolveSite(decodeURIComponent(host));
  const list = site ? await listPages(site) : null;
  if (!site || !list) return new Response('Not found', { status: 404 });

  const base = `https://${site.host}`;
  const groups = new Map<string, typeof list.pages>();
  for (const p of list.pages) if (p.translationGroupId) groups.set(p.translationGroupId, [...(groups.get(p.translationGroupId) ?? []), p]);

  const urls = list.pages.map((p) => {
    const alts = p.translationGroupId ? (groups.get(p.translationGroupId) ?? []) : [];
    const links = alts.map((a) => `<xhtml:link rel="alternate" hreflang="${esc(a.locale)}" href="${esc(base + localizedHref(site, a.locale, a.path))}"/>`).join('');
    return `<url><loc>${esc(base + localizedHref(site, p.locale, p.path))}</loc><lastmod>${new Date(p.updatedAt).toISOString()}</lastmod>${links}</url>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.join('')}</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' } });
}
