import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { UTM_COOKIE } from '@/lib/visitor';

const API = process.env.CANON_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 64 * 1024;

type Value = string | number | boolean | string[];

/** HTML form posts repeat keys for multi-selects; checkboxes arrive as "on". */
function fromFormData(fd: FormData): {
  data: Record<string, Value>;
  hp?: string;
  elapsedMs?: number;
  path?: string;
} {
  const data: Record<string, Value> = {};
  let hp: string | undefined;
  let elapsedMs: number | undefined;
  let path: string | undefined;
  for (const [k, v] of fd.entries()) {
    if (typeof v !== 'string') continue;
    if (k === '_hp') hp = v;
    else if (k === '_elapsed') elapsedMs = Number(v) || undefined;
    else if (k === '_path') path = v;
    else if (k in data)
      data[k] = [...(Array.isArray(data[k]) ? (data[k] as string[]) : [String(data[k])]), v];
    else data[k] = v;
  }
  return { data, hp, elapsedMs, path };
}

/**
 * The site's own endpoint for its forms: JSON from the enhanced form, or a classic form post when
 * JavaScript is off (answered with a redirect back to the page). Adds the client's IP, UA, host and
 * first-touch UTM, and forwards to the API with the server-only delivery token.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ formId: string }> }) {
  const { formId } = await params;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(formId))
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES)
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');

  let payload: {
    data: Record<string, Value>;
    honeypot?: string;
    elapsedMs?: number;
    path?: string;
    referrer?: string;
    locale?: string;
  };
  if (isJson) {
    const body = (await request.json().catch(() => null)) as typeof payload | null;
    if (!body || typeof body.data !== 'object' || body.data === null)
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST' }, { status: 400 });
    payload = body;
  } else {
    const f = fromFormData(await request.formData());
    payload = {
      data: f.data,
      honeypot: f.hp,
      elapsedMs: f.elapsedMs,
      path: f.path ?? new URL(request.headers.get('referer') ?? 'http://x/').pathname,
    };
  }

  let utm: unknown;
  try {
    utm = JSON.parse((await cookies()).get(UTM_COOKIE)?.value ?? 'null') ?? undefined;
  } catch {
    utm = undefined;
  }
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '')
    .split(':')[0]!
    .toLowerCase();
  const ip = (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0] ??
    ''
  ).trim();
  const res = await fetch(`${API}/v1/delivery/forms/${formId}/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-canon-delivery': process.env.DELIVERY_TOKEN ?? '',
      'x-canon-ua': request.headers.get('user-agent') ?? '',
      'x-canon-country':
        request.headers.get('cf-ipcountry') ?? request.headers.get('x-vercel-ip-country') ?? '',
      'x-canon-host': host,
      ...(ip ? { 'x-canon-ip': ip } : {}),
    },
    body: JSON.stringify({
      data: payload.data,
      ...(payload.honeypot ? { honeypot: payload.honeypot.slice(0, 500) } : {}),
      ...(payload.elapsedMs ? { elapsedMs: Math.min(86_400_000, Math.round(payload.elapsedMs)) } : {}),
      path: payload.path?.slice(0, 500),
      referrer: payload.referrer?.slice(0, 1_000),
      locale: payload.locale?.slice(0, 10),
      utm,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const out = res
    ? ((await res.json().catch(() => ({}))) as {
        successMessage?: string | null;
        redirectUrl?: string | null;
        error?: { code?: string; details?: { fields?: Record<string, string> } };
      })
    : null;
  const status = res?.status ?? 503;
  if (isJson) {
    return status === 202
      ? NextResponse.json({
          ok: true,
          successMessage: out?.successMessage ?? null,
          redirectUrl: out?.redirectUrl ?? null,
        })
      : NextResponse.json(
          { ok: false, code: out?.error?.code ?? 'UNAVAILABLE', fields: out?.error?.details?.fields ?? {} },
          { status },
        );
  }

  // No JavaScript: back to the page (or the configured thank-you URL) with the outcome in the query.
  const back = new URL(
    payload.path && payload.path.startsWith('/') ? payload.path : '/',
    `https://${host || 'localhost'}`,
  );
  if (status === 202 && out?.redirectUrl)
    return NextResponse.redirect(
      out.redirectUrl.startsWith('/') ? new URL(out.redirectUrl, back) : out.redirectUrl,
      303,
    );
  back.searchParams.set('form', status === 202 ? 'sent' : 'error');
  back.hash = `form-${formId}`;
  return NextResponse.redirect(back, 303);
}
