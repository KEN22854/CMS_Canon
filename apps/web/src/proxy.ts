import { NextResponse, type NextRequest } from 'next/server';

/**
 * Multi-domain routing: every host is rewritten to /s/<host>/<path>, so a single Next app serves
 * all customer sites and ISR caches per (host, path). The host comes from the request, which the
 * edge (Cloudflare/ingress) only forwards for domains it terminates — unknown hosts 404 in delivery.
 */
export function proxy(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return new NextResponse('Bad host', { status: 400 });
  const url = request.nextUrl.clone();
  url.pathname = `/s/${host}${url.pathname === '/' ? '' : url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Internal endpoints and assets are host-independent.
  matcher: ['/((?!api/|_next/|s/|favicon.ico).*)'],
};
