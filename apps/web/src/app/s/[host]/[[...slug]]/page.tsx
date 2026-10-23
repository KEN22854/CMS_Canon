import type { Metadata } from 'next';
import { cookies, draftMode } from 'next/headers';
import { notFound } from 'next/navigation';
import { BlockRenderer } from '@/components/blocks';
import { PREVIEW_COOKIE } from '@/lib/preview';
import { getPage, getPreview, localizedHref, resolveSite, splitLocale, type DeliveryPage, type DeliverySite } from '@/lib/delivery';

/** On-demand ISR: pages render on first request, stay cached, and are purged by tag on publish. */
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ host: string; slug?: string[] }>;

async function load(params: Params): Promise<{ site: DeliverySite; data: DeliveryPage } | null> {
  const { host, slug = [] } = await params;
  const site = await resolveSite(decodeURIComponent(host));
  if (!site) return null;
  const { locale, path } = splitLocale(site, slug.map(decodeURIComponent));
  // Cookies are read only in draft mode, so published pages stay statically cacheable.
  if ((await draftMode()).isEnabled) {
    const token = (await cookies()).get(PREVIEW_COOKIE)?.value;
    const preview = token ? await getPreview(token) : null;
    if (preview && preview.site.id === site.id && preview.page.path === path && preview.page.locale === locale) return { site, data: preview };
  }
  const data = await getPage(site, path, locale);
  return data ? { site, data } : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const loaded = await load(params);
  if (!loaded) return {};
  const { site, data } = loaded;
  const { page } = data;
  const title = page.seo.title || page.title;
  const template = site.seoDefaults.titleTemplate;
  const ogMedia = data.media[page.seo.ogImageMediaId ?? ''];
  const base = `https://${site.host}`;
  return {
    title: template ? template.replace('%s', title) : `${title} · ${site.name}`,
    description: page.seo.description || page.description || site.seoDefaults.description,
    robots: page.seo.noindex || data.draft ? { index: false, follow: false } : undefined,
    alternates: {
      canonical: page.seo.canonical ?? `${base}${localizedHref(site, page.locale, page.path)}`,
      // hreflang: every published translation of this page, plus x-default for the default locale.
      languages: Object.fromEntries([
        ...data.alternates.map((a) => [a.locale, `${base}${localizedHref(site, a.locale, a.path)}`]),
        ...data.alternates.filter((a) => a.locale === site.defaultLocale).map((a) => ['x-default', `${base}${a.path}`]),
      ]),
    },
    openGraph: { title, siteName: site.name, locale: page.locale, ...(ogMedia ? { images: [{ url: ogMedia.url, width: ogMedia.width ?? undefined, height: ogMedia.height ?? undefined }] } : {}) },
  };
}

export default async function SitePage({ params }: { params: Params }) {
  const loaded = await load(params);
  if (!loaded) notFound();
  const { site, data } = loaded;
  const { page } = data;
  return (
    <div lang={page.locale}>
      {data.draft && (
        <div className="sticky top-0 z-50 flex items-center justify-center gap-4 bg-amber-400 px-4 py-2 text-sm font-medium text-black">
          Preview — you are viewing an unpublished draft
          <a href="/api/draft/exit" className="underline">Exit preview</a>
        </div>
      )}
      <header className="border-b border-foreground/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <a href={localizedHref(site, page.locale, '/')} className="text-lg font-bold">
            {site.name}
          </a>
          <nav className="flex flex-wrap items-center gap-5 text-sm" aria-label="Main">
            {data.nav.map((n) => (
              <a key={n.path} href={localizedHref(site, page.locale, n.path)} className={`hover:text-primary ${n.path === page.path ? 'font-semibold text-primary' : ''}`}>
                {n.title}
              </a>
            ))}
            {data.alternates.length > 1 && (
              <span className="flex gap-2 border-l border-foreground/10 pl-4 uppercase">
                {data.alternates.map((a) => (
                  <a key={a.locale} href={localizedHref(site, a.locale, a.path)} hrefLang={a.locale} className={a.locale === page.locale ? 'font-semibold' : 'opacity-60 hover:opacity-100'}>
                    {a.locale}
                  </a>
                ))}
              </span>
            )}
          </nav>
        </div>
      </header>
      <main>
        <BlockRenderer node={page.content.root} ctx={{ media: data.media, facts: data.facts, draft: data.draft }} isRoot />
      </main>
      <footer className="border-t border-foreground/10 py-8 text-center text-sm opacity-60">
        © {new Date().getFullYear()} {site.name}
      </footer>
    </div>
  );
}
