import { NextResponse, type NextRequest } from 'next/server';
import { resolveSite } from '@/lib/delivery';

const API = process.env.CANON_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 32 * 1024;

/**
 * The site's own checkout endpoint. The site is the one the request's host serves (never an id
 * from the browser); the order goes to the API with the server-only delivery token, the visitor's
 * IP and the host, which the API checks again.
 */
export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return NextResponse.json({ ok: false, code: 'TOO_LARGE' }, { status: 413 });
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
  const site = host ? await resolveSite(host) : null;
  if (!site) return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== 'object') return NextResponse.json({ ok: false, code: 'BAD_REQUEST' }, { status: 400 });
  const ip = (request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0] ?? '').trim();

  const res = await fetch(`${API}/v1/delivery/sites/${encodeURIComponent(site.id)}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-canon-delivery': process.env.DELIVERY_TOKEN ?? '', 'x-canon-host': host, ...(ip ? { 'x-canon-ip': ip } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return NextResponse.json({ ok: false, code: 'UNAVAILABLE' }, { status: 503 });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: string; message?: string } };
  if (res.status === 201) return NextResponse.json({ ok: true, ...out }, { status: 201 });
  return NextResponse.json({ ok: false, code: out.error?.code ?? 'ERROR', message: out.error?.message ?? '' }, { status: res.status });
}
