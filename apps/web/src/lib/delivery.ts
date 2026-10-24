import 'server-only';
import type { PageContent } from '@canon/blocks';

export interface SiteTheme {
  colors: { primary: string; background: string; foreground: string; muted: string };
  font: 'system' | 'serif' | 'mono' | 'Inter' | 'Manrope' | 'Lora';
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  mode: 'light' | 'dark' | 'auto';
}

export interface DeliverySite {
  id: string;
  name: string;
  host: string;
  defaultLocale: string;
  locales: string[];
  theme: SiteTheme;
  seoDefaults: { titleTemplate?: string; description?: string; ogImageMediaId?: string };
  favicon: string | null;
  logo: string | null;
}

export interface DeliveryMedia {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  mimeType: string;
  dominantColor: string | null;
  variants: { thumb?: { url: string }; sources: { url: string; width: number; height: number; format: 'webp' | 'avif' }[] } | null;
}

export interface DeliveryPage {
  draft: boolean;
  site: DeliverySite;
  page: {
    id: string;
    title: string;
    description: string | null;
    locale: string;
    path: string;
    seo: { title?: string; description?: string; ogImageMediaId?: string; noindex?: boolean; canonical?: string };
    content: PageContent;
    publishedAt: string | null;
  };
  alternates: { locale: string; path: string }[];
  nav: { title: string; path: string }[];
  media: Record<string, DeliveryMedia>;
  facts: Record<string, string>;
  /** Which experiment variants / segment the API actually applied (re-validated server-side). */
  applied?: { experiments: { testId: string; variantId: string }[]; segmentId: string | null };
}

export interface DeliveryList {
  site: DeliverySite;
  pages: { id: string; title: string; path: string; locale: string; updatedAt: string; translationGroupId: string | null }[];
}

const API = process.env.CANON_API_URL ?? 'http://localhost:4000';
/** Long ISR window: freshness comes from on-demand revalidation on publish, not from polling. */
const REVALIDATE_SEC = 3_600;


async function get<T>(path: string, tags: string[], cache: 'isr' | 'none' = 'isr'): Promise<T | null> {
  const res = await fetch(`${API}/v1/delivery${path}`, {
    headers: { 'x-canon-delivery': process.env.DELIVERY_TOKEN ?? '' },
    ...(cache === 'none' ? { cache: 'no-store' as const } : { next: { tags, revalidate: REVALIDATE_SEC } }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Delivery ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function resolveSite(host: string): Promise<DeliverySite | null> {
  return get<DeliverySite>(`/resolve?host=${encodeURIComponent(host)}`, [`host:${host}`]);
}

export function getPage(site: DeliverySite, path: string, locale: string, variant?: string): Promise<DeliveryPage | null> {
  const v = variant ? `&variant=${encodeURIComponent(variant)}` : '';
  return get<DeliveryPage>(`/sites/${site.id}/page?path=${encodeURIComponent(path)}&locale=${locale}${v}`, [`site:${site.id}`, `host:${site.host}`]);
}

export function getPreview(token: string): Promise<DeliveryPage | null> {
  return get<DeliveryPage>(`/preview?token=${encodeURIComponent(token)}`, [], 'none');
}

export function listPages(site: DeliverySite): Promise<DeliveryList | null> {
  return get<DeliveryList>(`/sites/${site.id}/pages`, [`site:${site.id}`]);
}

/** URL path ↔ (locale, page path). The default locale is unprefixed; others live under /<locale>. */
export function splitLocale(site: DeliverySite, segments: string[]): { locale: string; path: string } {
  const [first, ...rest] = segments;
  if (first && first !== site.defaultLocale && site.locales.includes(first)) return { locale: first, path: `/${rest.join('/')}`.replace(/\/$/, '') || '/' };
  return { locale: site.defaultLocale, path: `/${segments.join('/')}`.replace(/\/$/, '') || '/' };
}

export function localizedHref(site: DeliverySite, locale: string, path: string): string {
  if (locale === site.defaultLocale) return path;
  return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

