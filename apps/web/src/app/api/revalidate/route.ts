import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';

/** Called by the API's outbox relay after publish/unpublish/move; purges ISR entries by tag. */
export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET ?? '';
  const given = req.headers.get('x-canon-revalidate') ?? '';
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { tags?: unknown } | null;
  const tags = Array.isArray(body?.tags) ? body.tags.filter((t): t is string => typeof t === 'string' && /^(site|host):[\w.-]+$/.test(t)) : [];
  // expire: 0 → the next request re-renders instead of serving stale content: a publish is visible at once.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return NextResponse.json({ revalidated: tags });
}
