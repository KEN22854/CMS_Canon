import { describe, expect, it } from 'vitest';
import {
  blockCatalogForPrompt,
  materializeBlocks,
  videoEmbedUrl,
  collectMediaIds,
  collectPageFactKeys,
  collectTextFields,
  emptyDoc,
  emptyPageContent,
  mapTextFields,
  richTextSchema,
  richTextToPlain,
  validatePageContent,
  type BlockNode,
} from '../src';

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: BlockNode[] = []): BlockNode => ({ id, type, props, children });

const page = () => ({
  root: node('root', 'section', {}, [
    node('h', 'hero', { title: 'Ship faster', subtitle: 'Connect tools', ctaHref: '/signup', ctaLabel: 'Start', mediaId: 'm1' }),
    node('t', 'text', {
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pro costs ' }, { type: 'factRef', attrs: { factKey: 'pro_plan.price' } }, { type: 'text', text: '.' }] }] },
    }),
    node('i', 'image', { mediaId: 'm2' }),
  ]),
});

describe('validatePageContent', () => {
  it('accepts a valid tree and fills prop defaults', () => {
    const res = validatePageContent(page());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.content.root.props).toMatchObject({ background: 'default', paddingY: 'lg' });
      expect(res.content.root.children[0]!.props).toMatchObject({ align: 'center', eyebrow: '' });
    }
  });

  it('rejects unknown types, children in leaf blocks, duplicate ids and bad props', () => {
    const bad = {
      root: node('root', 'section', {}, [node('x', 'marquee'), node('h', 'heading', { text: 'ok' }, [node('h', 'button', { label: 'a', href: '/' })]), node('b', 'button', { label: '', href: 'javascript:alert(1)' })]),
    };
    const res = validatePageContent(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msgs = res.issues.map((i) => i.message).join(' | ');
      expect(msgs).toContain('Unknown block type "marquee"');
      expect(msgs).toContain('"heading" cannot contain other blocks');
      expect(msgs).toContain('Duplicate block id "h"');
      expect(msgs).toMatch(/Only http\(s\)/);
    }
  });

  it('accepts unknown types that are registered (plugins / later phases)', () => {
    const res = validatePageContent({ root: node('root', 'section', {}, [node('f', 'faq', { items: [] })]) }, { registeredTypes: new Set(['faq']) });
    expect(res.ok).toBe(true);
  });

  it('limits depth', () => {
    let leaf = node('n7', 'section');
    for (let i = 6; i >= 1; i--) leaf = node(`n${i}`, 'section', {}, [leaf]);
    expect(validatePageContent({ root: leaf }).ok).toBe(false);
  });
});

describe('rich text', () => {
  it('rejects raw HTML nodes and javascript: links', () => {
    expect(richTextSchema.safeParse({ type: 'doc', content: [{ type: 'html', html: '<script>' }] }).success).toBe(false);
    const evil = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] };
    expect(richTextSchema.safeParse(evil).success).toBe(false);
  });

  it('renders fact tokens from the resolver', () => {
    const doc = (page().root.children[1]!.props as { doc: Parameters<typeof richTextToPlain>[0] }).doc;
    expect(richTextToPlain(doc, { 'pro_plan.price': '$49/month' })).toBe('Pro costs $49/month.');
  });
});

describe('text field helpers', () => {
  it('collects AI-editable texts and never URLs', () => {
    const fields = collectTextFields(page());
    expect(fields.map((f) => `${f.blockId}.${f.prop}`)).toEqual(['h.title', 'h.subtitle', 'h.ctaLabel', 't.doc']);
  });

  it('maps texts while keeping structure and fact tokens', () => {
    const out = mapTextFields(page(), (t) => t.toUpperCase());
    const hero = out.root.children[0]!.props;
    expect(hero.title).toBe('SHIP FASTER');
    expect(hero.ctaHref).toBe('/signup');
    expect(collectPageFactKeys(out)).toEqual(['pro_plan.price']);
  });

  it('collects media references', () => {
    expect(collectMediaIds(page()).sort()).toEqual(['m1', 'm2']);
  });

  it('empty content is valid', () => {
    expect(validatePageContent(emptyPageContent()).ok).toBe(true);
    expect(richTextSchema.safeParse(emptyDoc('hi')).success).toBe(true);
  });
});

describe('phase 3 blocks', () => {
  it('validates columns: rows hold only columns', () => {
    const ok = validatePageContent({ root: node('root', 'section', {}, [node('r', 'row', {}, [node('c1', 'column', { width: '1/2' }, [node('h', 'heading', { text: 'A' })]), node('c2', 'column')])]) });
    expect(ok.ok).toBe(true);
    const bad = validatePageContent({ root: node('root', 'section', {}, [node('r', 'row', {}, [node('h', 'heading', { text: 'A' })])]) });
    expect(bad.ok).toBe(false);
  });

  it('only accepts YouTube/Vimeo video URLs and builds privacy-friendly embeds', () => {
    expect(validatePageContent({ root: node('root', 'section', {}, [node('v', 'video', { url: 'https://evil.example/x' })]) }).ok).toBe(false);
    expect(videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbedUrl('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789?dnt=1');
  });

  it('collects and maps text inside list items', () => {
    const content = { root: node('root', 'section', {}, [node('f', 'faq', { title: 'FAQ', items: [{ q: 'Why?', a: 'Because.' }] })]) };
    expect(collectTextFields(content).map((f) => `${f.prop}${f.item ? `[${f.item.index}].${f.item.prop}` : ''}`)).toEqual(['title', 'items[0].q', 'items[0].a']);
    const out = mapTextFields(content, (t) => `<${t}>`);
    expect(out.root.children[0]!.props.items).toEqual([{ q: '<Why?>', a: '<Because.>' }]);
  });
});

describe('AI catalog & materialize', () => {
  it('describes every block for prompts', () => {
    const cat = blockCatalogForPrompt();
    for (const t of ['hero', 'faq', 'row', 'stats']) expect(cat).toContain(`- ${t}:`);
    expect(cat).toContain('children: column only');
  });

  it('keeps valid generated blocks, drops invalid ones with reasons and regenerates ids', () => {
    const res = materializeBlocks([
      { id: 'root', type: 'hero', props: { title: 'Hi' } },
      { type: 'button', props: { label: 'x', href: 'javascript:1' } },
      { type: 'marquee', props: {} },
      'garbage',
    ]);
    expect(res.content.root.children.map((c) => c.type)).toEqual(['hero']);
    expect(res.content.root.children[0]!.id).not.toBe('root');
    expect(res.dropped.map((d) => d.type)).toEqual(['button', 'marquee', 'unknown']);
  });

  it('coerces model quirks and binds known fact tokens', () => {
    const res = materializeBlocks(
      [
        { type: 'heading', props: { text: 'Plans', level: '3', bogus: 1 } },
        { type: 'text', props: { doc: 'Pro costs {{fact:pro_plan.price}} today.\n\nAsk {{fact:nope.key}} us.' } },
        { type: 'stats', props: { items: [{ value: '{{fact:pro_plan.price}}', label: 'Pro' }] } },
      ],
      { facts: { 'pro_plan.price': '$49/month' } },
    );
    expect(res.dropped).toEqual([]);
    const [h, t, st] = res.content.root.children;
    expect(h!.props.level).toBe(3);
    expect(collectPageFactKeys(res.content)).toEqual(['pro_plan.price']);
    expect(richTextToPlain(t!.props.doc as Parameters<typeof richTextToPlain>[0], { 'pro_plan.price': '$49' })).toBe('Pro costs $49 today.\n\nAsk  us.');
    expect(st!.props.items).toEqual([{ value: '$49/month', label: 'Pro' }]);
  });
});
