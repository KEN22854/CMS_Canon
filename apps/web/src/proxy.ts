import { deviceFromUserAgent, encodeVariantKey, isBot, primaryLanguage, referrerDomain, selectVariants, type VisitorContext } from '@canon/edge';
import { NextResponse, type NextRequest } from 'next/server';
import { hostInfo, runtimeConfig } from './lib/runtime';
import { SESSION_COOKIE, UTM_COOKIE, VISITOR_COOKIE, VISITS_COOKIE } from './lib/visitor';

const SESSION_MS = 30 * 60_000;
const YEAR_S = 365 * 24 * 3600;

/**
 * Multi-domain routing: every host is rewritten to /s/<host>/<path>, so a single Next app serves
 * all customer sites and ISR caches per (host, path). The host comes from the request, which the
 * edge (Cloudflare/ingress) only forwards for domains it terminates — unknown hosts 404 in delivery.
 *
 * Experiments and personalization are decided here, per visitor, and expressed as a variant
 * segment in the rewritten path (/s/<host>/~t.<test>.<variant>~s.<segment>/<path>). Each variant
 * is therefore its own static ISR entry: no per-visitor rendering, no flicker, no client script.
 * Bots and previews always get the original page.
 */
export async function proxy(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return new NextResponse('Bad host', { status: 400 });
  const url = request.nextUrl.clone();
  const path = url.pathname === '/' ? '' : url.pathname;
  const ua = request.headers.get('user-agent');
  const preview = request.cookies.has('__prerender_bypass');
  if (request.method !== 'GET' || preview || isBot(ua) || path.startsWith('/~')) {
    url.pathname = `/s/${host}${path}`;
    return NextResponse.rewrite(url);
  }

  // Visitor identity is a random first-party id — no fingerprinting, nothing personal in it.
  const now = Date.now();
  const visitorId = request.cookies.get(VISITOR_COOKIE)?.value ?? crypto.randomUUID();
  const newSession = !request.cookies.get(SESSION_COOKIE)?.value;
  const sessionId = request.cookies.get(SESSION_COOKIE)?.value ?? crypto.randomUUID();
  const visits = Math.max(1, Number(request.cookies.get(VISITS_COOKIE)?.value ?? 0) + (newSession ? 1 : 0));
  const utm = firstTouchUtm(request);

  let variant: string | null = null;
  const site = await hostInfo(host);
  const cfg = site ? await runtimeConfig(site.id) : null;
  if (site && cfg && (cfg.experiments.length || cfg.personalization.length)) {
    const { locale, path: pagePath } = splitLocale(site, url.pathname);
    const ctx: VisitorContext = {
      visitorId,
      visitCount: visits,
      country: request.headers.get('cf-ipcountry') ?? request.headers.get('x-vercel-ip-country') ?? request.headers.get('x-country'),
      device: deviceFromUserAgent(ua),
      language: primaryLanguage(request.headers.get('accept-language')),
      referrerDomain: referrerDomain(request.headers.get('referer'), host),
      utmSource: utm.source ?? null,
      utmMedium: utm.medium ?? null,
      utmCampaign: utm.campaign ?? null,
      path: pagePath,
    };
    variant = encodeVariantKey(selectVariants(cfg, pagePath, locale, ctx));
  }

  url.pathname = `/s/${host}${variant ? `/${variant}` : ''}${path}`;
  const res = NextResponse.rewrite(url);
  const cookie = { path: '/', sameSite: 'lax' as const, secure: request.nextUrl.protocol === 'https:', httpOnly: true };
  if (!request.cookies.has(VISITOR_COOKIE)) res.cookies.set(VISITOR_COOKIE, visitorId, { ...cookie, maxAge: YEAR_S });
  res.cookies.set(SESSION_COOKIE, sessionId, { ...cookie, expires: new Date(now + SESSION_MS) });
  if (newSession) res.cookies.set(VISITS_COOKIE, String(visits), { ...cookie, maxAge: YEAR_S });
  if (utm.fresh) res.cookies.set(UTM_COOKIE, JSON.stringify({ source: utm.source, medium: utm.medium, campaign: utm.campaign }), { ...cookie, maxAge: 30 * 24 * 3600 });
  return res;
}

/** First-touch attribution: UTM tags from the landing URL, remembered for 30 days. */
function firstTouchUtm(request: NextRequest): { source?: string; medium?: string; campaign?: string; fresh: boolean } {
  const q = request.nextUrl.searchParams;
  const clip = (v: string | null) => (v ? v.slice(0, 100).toLowerCase() : undefined);
  if (q.get('utm_source')) return { source: clip(q.get('utm_source')), medium: clip(q.get('utm_medium')), campaign: clip(q.get('utm_campaign')), fresh: true };
  try {
    const saved = JSON.parse(request.cookies.get(UTM_COOKIE)?.value ?? '{}') as Record<string, unknown>;
    const s = (k: string) => (typeof saved[k] === 'string' ? (saved[k] as string).slice(0, 100) : undefined);
    return { source: s('source'), medium: s('medium'), campaign: s('campaign'), fresh: false };
  } catch {
    return { fresh: false };
  }
}

function splitLocale(site: { defaultLocale: string; locales: string[] }, pathname: string): { locale: string; path: string } {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [first, ...rest] = segments;
  if (first && first !== site.defaultLocale && site.locales.includes(first)) return { locale: first, path: `/${rest.join('/')}` };
  return { locale: site.defaultLocale, path: `/${segments.join('/')}` };
}

export const config = {
  // Internal endpoints and assets are host-independent.
  matcher: ['/((?!api/|_next/|s/|favicon.ico).*)'],
};
