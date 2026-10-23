import { cookies, draftMode } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { PREVIEW_COOKIE } from '@/lib/preview';

export async function GET(req: NextRequest) {
  (await draftMode()).disable();
  (await cookies()).delete(PREVIEW_COOKIE);
  return NextResponse.redirect(new URL('/', req.url));
}
