import { describe, expect, it } from 'vitest';
import { bindEntry, collectListSpecs, entryTokensIn, fillEntryTokens, listItemOf, validatePageContent, type BlockNode, type PageContent } from '../src';

const n = (id: string, type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id, type, props, children });
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const entry = {
  title: 'Sourdough',
  slug: 'sourdough',
  summary: 'A slow loaf',
  publishedAt: new Date('2026-11-04T10:00:00Z'),
  data: { price: 12, tags: ['bread', 'home'], cover: 'https://images.unsplash.com/photo-1', evil: 'https://evil.example.com/x.jpg', body: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Step one' }] }] } },
};

describe('entry pages', () => {
  it('fills tokens in any prop: numbers, dates, lists, rich text; unknown fields become empty', () => {
    expect(fillEntryTokens('{{entry.title}} — {{ entry.price }} € · {{entry.publishedAt}} · {{entry.tags}} · [{{entry.nope}}]', entry)).toBe('Sourdough — 12 € · 2026-11-04 · bread, home · []');
    const page: PageContent = {
      root: n('root', 'section', {}, [
        n('f', 'features', { title: '{{entry.title}}', columns: 3, items: [{ title: '{{entry.summary}}', text: '' }] }),
        n('t', 'text', { doc: doc('{{entry.body}}') }),
        n('i', 'image', { mediaId: '', src: '{{entry.cover}}', alt: '{{entry.title}}' }),
        n('x', 'image', { mediaId: '', src: '{{entry.evil}}', alt: '' }),
      ]),
    };
    // The template itself is valid page content (tokens are allowed where links go).
    expect(validatePageContent(page).ok).toBe(true);
    expect(entryTokensIn(page).sort()).toEqual(['body', 'cover', 'evil', 'summary', 'title']);
    const out = bindEntry(page, entry).root.children;
    expect(out[0]!.props).toMatchObject({ title: 'Sourdough', items: [{ title: 'A slow loaf' }] });
    // A rich text field alone in a paragraph brings its own structure.
    expect(out[1]!.props.doc).toEqual({ type: 'doc', content: entry.data.body.content });
    expect(out[2]!.props.src).toBe('https://images.unsplash.com/photo-1');
    // A link from the entry passes the same host allowlist as a typed one: off-list hosts are dropped.
    expect(out[3]!.props.src).toBe('');
  });

  it('re-checks links built from entry data (no //host, no scripts)', () => {
    const page: PageContent = { root: n('root', 'section', {}, [n('a', 'button', { label: 'Go', href: '/{{entry.path}}', variant: 'primary', align: 'left' }), n('b', 'button', { label: 'Shop', href: '{{entry.shop}}', variant: 'primary', align: 'left' }), n('c', 'button', { label: 'Ok', href: '{{entry.ok}}', variant: 'primary', align: 'left' })]) };
    expect(validatePageContent(page).ok).toBe(true);
    const out = bindEntry(page, { ...entry, data: { path: '/evil.example/x', shop: 'javascript:alert(1)', ok: 'https://partner.example/buy' } }).root.children;
    expect(out.map((c) => c.props.href)).toEqual(['', '', 'https://partner.example/buy']);
    expect(validatePageContent({ root: n('r', 'section', {}, [n('x', 'button', { label: 'x', href: '//evil.example', variant: 'primary', align: 'left' })]) }).ok).toBe(false);
  });

  it('builds list cards: automatic image and text, allowlisted links only, entry path', () => {
    const fields = [{ name: 'cover', type: 'url' }, { name: 'intro', type: 'textarea' }];
    const a = listItemOf({ id: 'e1', ...entry, summary: null, data: { cover: 'https://images.unsplash.com/p', intro: 'x'.repeat(300) } }, fields, { imageField: '', textField: '' }, '/blog/sourdough');
    expect(a).toMatchObject({ title: 'Sourdough', path: '/blog/sourdough', imageUrl: 'https://images.unsplash.com/p', mediaId: null, date: '2026-11-04' });
    expect(a.text.length).toBeLessThanOrEqual(220);
    const b = listItemOf({ id: 'e2', ...entry, data: { cover: 'http://images.unsplash.com/p' } }, fields, { imageField: 'cover', textField: '' }, null);
    expect(b).toMatchObject({ imageUrl: null, text: 'A slow loaf', path: null });
    const media = listItemOf({ id: 'e3', ...entry, data: { photo: ['m1', 'm2'] } }, [{ name: 'photo', type: 'media' }], { imageField: '', textField: '' }, null);
    expect(media.mediaId).toBe('m1');
  });

  it('finds Collection list blocks with bounded limits', () => {
    const root = n('root', 'section', {}, [n('s', 'section', {}, [n('l', 'collection-list', { collection: 'posts', limit: 500, sort: 'oldest' })]), n('e', 'collection-list', { collection: '' })]);
    expect(collectListSpecs(root)).toEqual([{ blockId: 'l', collection: 'posts', limit: 24, sort: 'oldest', tag: '', imageField: '', textField: '' }]);
  });
});
