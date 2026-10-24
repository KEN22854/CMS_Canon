/**
 * What the edge knows about a request, built only from the request itself and first-party
 * cookies — no fingerprinting, no third-party lookups. Everything here must be cheap enough to
 * run on every page request in the renderer's proxy.
 */
export type Device = 'mobile' | 'tablet' | 'desktop';

export interface VisitorContext {
  visitorId: string;
  /** 1 on the first visit; incremented per session by the tracker cookie. */
  visitCount: number;
  country: string | null;
  device: Device;
  language: string | null;
  referrerDomain: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  path: string;
}

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|headless|lighthouse|pagespeed|facebookexternalhit|embedly|quora link preview|whatsapp|telegrambot|preview/i;

export function isBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_RE.test(userAgent);
}

export function deviceFromUserAgent(ua: string | null | undefined): Device {
  const s = ua ?? '';
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(s)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(s)) return 'mobile';
  return 'desktop';
}

export function browserFromUserAgent(ua: string | null | undefined): string {
  const s = ua ?? '';
  if (/edg\//i.test(s)) return 'Edge';
  if (/opr\//i.test(s)) return 'Opera';
  if (/firefox\//i.test(s)) return 'Firefox';
  if (/chrome\//i.test(s)) return 'Chrome';
  if (/safari\//i.test(s)) return 'Safari';
  return 'Other';
}

export function osFromUserAgent(ua: string | null | undefined): string {
  const s = ua ?? '';
  if (/iphone|ipad|ipod/i.test(s)) return 'iOS';
  if (/android/i.test(s)) return 'Android';
  if (/windows/i.test(s)) return 'Windows';
  if (/mac os x|macintosh/i.test(s)) return 'macOS';
  if (/linux/i.test(s)) return 'Linux';
  return 'Other';
}

/** "https://www.google.com/search?q=…" → "google.com"; same-site and invalid referrers → null. */
export function referrerDomain(referrer: string | null | undefined, ownHost?: string): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (ownHost && host === ownHost.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '')) return null;
    return host || null;
  } catch {
    return null;
  }
}

/** "de-DE,de;q=0.9,en;q=0.8" → "de". */
export function primaryLanguage(acceptLanguage: string | null | undefined): string | null {
  const first = acceptLanguage?.split(',')[0]?.trim().split(';')[0]?.trim();
  return first ? first.slice(0, 2).toLowerCase() : null;
}
