import { NextResponse, type NextRequest } from 'next/server';
import { getPage, resolveSite } from '@/lib/delivery';

/**
 * The site's own 404 page (a published page at /404), for the client part of not-found.tsx.
 * A route handler may read the host header; the not-found page itself may not, because that would
 * make every cached page of the segment dynamic.
 */
export async function GET(req: NextRequest) {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return NextResponse.json(null, { status: 400 });
  const site = await resolveSite(host).catch(() => null);
  const data = site ? await getPage(site, '/404', site.defaultLocale).catch(() => null) : null;
  if (!data) return NextResponse.json(null, { status: 404 });
  return NextResponse.json({ locale: data.page.locale, content: data.page.content, media: data.media, facts: data.facts }, { headers: { 'cache-control': 'public, max-age=60' } });
}
