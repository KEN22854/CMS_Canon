import { describe, expect, it } from 'vitest';
import { auditPage, jsonLd, structuredData, type BlockNode, type SeoPageInput, type SeoSiteContext } from '../src';

const node = (id: string, type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id, type, props, children });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const doc = (text: string, href?: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }] }] });

const site = (over: Partial<SeoSiteContext> = {}): SeoSiteContext => ({ knownPaths: new Set(['/', '/pricing']), titleCounts: new Map(), descriptionCounts: new Map(), mediaAlt: { m1: 'A team photo', m2: null }, defaultOgImage: true, ...over });

const good: SeoPageInput = {
  id: 'p1',
  title: 'Pricing for growing teams',
  path: '/pricing',
  description: null,
  seo: { description: 'Simple plans for teams of every size. Start free and upgrade when you need more.' },
  content: { root: node('root', 'section', {}, [node('hero', 'hero', { title: 'Pricing', ctaLabel: 'Start', ctaHref: '/pricing' }), node('h', 'heading', { text: 'Plans', level: 2 }), node('t', 'text', { doc: doc(words(150), '/') }), node('img', 'image', { mediaId: 'm1', alt: '' })]) },
};

describe('SEO audit', () => {
  it('passes a well-formed page', () => {
    const r = auditPage(good, site());
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.words).toBeGreaterThan(150);
  });

  it('finds title, description, heading, image, link and content problems', () => {
    const page: SeoPageInput = {
      ...good,
      title: 'Hi',
      seo: { noindex: true },
      content: {
        root: node('root', 'section', {}, [
          node('h1a', 'heading', { text: 'One', level: 1 }),
          node('h1b', 'heading', { text: 'Two', level: 1 }),
          node('h4', 'heading', { text: 'Deep', level: 4 }),
          node('img', 'image', { mediaId: 'm2', alt: '' }),
          node('b1', 'button', { label: 'Go', href: '#' }),
          node('b2', 'button', { label: 'Old', href: '/old-page?x=1' }),
          node('b3', 'button', { label: '', href: '/nowhere' }), // no label: renders no link
          node('t', 'text', { doc: doc('short', '/missing') }),
        ]),
      },
    };
    const r = auditPage(page, site({ defaultOgImage: false }));
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['title-short', 'description-missing', 'noindex', 'og-image-missing', 'h1-multiple', 'heading-skip', 'image-alt', 'link-empty', 'link-broken', 'thin-content']));
    expect(r.issues.filter((i) => i.code === 'link-broken').map((i) => i.detail)).toEqual(['/old-page?x=1', '/missing']);
    expect(r.issues.find((i) => i.code === 'image-alt')!.blockId).toBe('img');
    expect(r.score).toBeLessThan(50);
  });

  it('flags a missing h1 and duplicates across the site', () => {
    const page = { ...good, content: { root: node('root', 'section', {}, [node('t', 'text', { doc: doc(words(200)) })]) } };
    const r = auditPage(page, site({ titleCounts: new Map([['pricing for growing teams', 2]]) }));
    expect(r.issues.map((i) => i.code)).toEqual(['title-duplicate', 'h1-missing']);
  });
});

describe('structured data', () => {
  const content = { root: node('root', 'section', {}, [node('f', 'faq', { title: 'Q', items: [{ q: 'Free plan?', a: 'Yes.' }] }), { ...node('f2', 'faq', { items: [{ q: 'Hidden?', a: 'No.' }] }), hidden: true }]) };
  it('emits organisation and website on the home page, breadcrumbs and FAQ elsewhere', () => {
    const home = structuredData({ site: { name: 'Acme', url: 'https://acme.test', locale: 'en' }, page: { title: 'Home', path: '/', content, isHome: true }, breadcrumbs: [] });
    expect(home.map((d) => d['@type'])).toEqual(['Organization', 'WebSite', 'FAQPage']);
    const deep = structuredData({ site: { name: 'Acme', url: 'https://acme.test', locale: 'en' }, page: { title: 'Pro', path: '/pricing/pro', content: { root: node('root', 'section', {}) }, isHome: false }, breadcrumbs: [{ title: 'Pricing', path: '/pricing' }] });
    expect(deep[0]).toMatchObject({ '@type': 'BreadcrumbList', itemListElement: [{ position: 1, item: 'https://acme.test' }, { position: 2, name: 'Pricing', item: 'https://acme.test/pricing' }, { position: 3, name: 'Pro' }] });
    expect(JSON.stringify(home)).not.toContain('Hidden?');
  });

  it('escapes markup so JSON-LD cannot close its script tag', () => {
    expect(jsonLd({ name: '</script><script>alert(1)</script>' })).not.toContain('<');
  });
});
