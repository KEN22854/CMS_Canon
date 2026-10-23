import { cookies, draftMode } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { getPreview, localizedHref } from '@/lib/delivery';
import { PREVIEW_COOKIE } from '@/lib/preview';

/**
 * Entry point of a preview link from the admin. The token is verified by the API (signature, page,
 * tenant) before draft mode turns on, and the redirect target comes from the verified page — never
 * from a query parameter, so this cannot be abused as an open redirect.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  const preview = token ? await getPreview(token).catch(() => null) : null;
  if (!token || !preview) return new NextResponse('Preview link is invalid or expired', { status: 401 });

  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(':')[0];
  if (host !== preview.site.host) return new NextResponse('Preview link belongs to another site', { status: 403 });

  (await draftMode()).enable();
  (await cookies()).set(PREVIEW_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 30 * 60 });
  return NextResponse.redirect(new URL(localizedHref(preview.site, preview.page.locale, preview.page.path), req.url));
}
