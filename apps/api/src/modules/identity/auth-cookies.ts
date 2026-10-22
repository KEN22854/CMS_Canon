import type { CookieOptions, Request, Response } from 'express';
import { forbidden } from '../../common/http/api-error';
import type { AppConfig } from '../../config/env';

export const REFRESH_COOKIE = 'canon_rt';

/**
 * Browser clients keep the refresh token only in an httpOnly, SameSite=Strict cookie (out of
 * reach of XSS); the access token lives in memory. Native/server clients opt into receiving the
 * refresh token in the body with `x-canon-client: native`.
 */
export function cookieOptions(config: AppConfig, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    domain: config.AUTH_COOKIE_DOMAIN,
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

export function isNativeClient(req: Request): boolean {
  return req.header('x-canon-client') === 'native';
}

export function readRefreshToken(req: Request, bodyToken?: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return bodyToken ?? cookies?.[REFRESH_COOKIE];
}

export function setRefreshCookie(res: Response, config: AppConfig, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(config, expiresAt.getTime() - Date.now()));
}

export function clearRefreshCookie(res: Response, config: AppConfig): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions(config));
}

/**
 * Defence in depth for cookie-authenticated endpoints: SameSite=Strict already blocks cross-site
 * sends, and this rejects any request whose Origin is not one of ours (old browsers, misconfig).
 */
export function assertTrustedOrigin(req: Request, config: AppConfig, usedCookie: boolean): void {
  if (!usedCookie) return;
  const origin = req.header('origin');
  if (!origin) return;
  const allowed = new Set([...config.CORS_ORIGINS, new URL(config.ADMIN_PUBLIC_URL).origin, new URL(config.API_PUBLIC_URL).origin]);
  if (!allowed.has(origin)) throw forbidden('Untrusted origin');
}
