/** Rendered per request (hosts are unknown at build time); the delivery fetches underneath are ISR-cached by tag. */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ host: string }> }) {
  const { host } = await params;
  const h = decodeURIComponent(host);
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: https://${h}/sitemap.xml\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, s-maxage=86400' } });
}
