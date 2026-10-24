import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, UTM_COOKIE, VISITOR_COOKIE } from '@/lib/visitor';

const API = process.env.CANON_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 32 * 1024;

/**
 * First-party collector endpoint for the tracker: attaches the visitor/session ids and first-touch
 * UTM from httpOnly cookies, plus the request's UA/country/host, and forwards to the API with the
 * server-only delivery token. Always answers 202 — analytics must never break a page.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return new NextResponse(null, { status: 413 });
  const jar = await cookies();
  const visitorId = jar.get(VISITOR_COOKIE)?.value;
  const sessionId = jar.get(SESSION_COOKIE)?.value;
  if (!visitorId || !sessionId) return new NextResponse(null, { status: 202 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  let utm: unknown;
  try {
    utm = JSON.parse(jar.get(UTM_COOKIE)?.value ?? 'null') ?? undefined;
  } catch {
    utm = undefined;
  }
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  await fetch(`${API}/v1/delivery/collect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-canon-delivery': process.env.DELIVERY_TOKEN ?? '',
      'x-canon-ua': request.headers.get('user-agent') ?? '',
      'x-canon-country': request.headers.get('cf-ipcountry') ?? request.headers.get('x-vercel-ip-country') ?? request.headers.get('x-country') ?? '',
      'x-canon-host': host,
    },
    body: JSON.stringify({ ...body, visitorId, sessionId, utm }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  return new NextResponse(null, { status: 202 });
}
