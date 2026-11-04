import { describe, expect, it } from 'vitest';
import { compileStyles, parseCssDeclarations, stylesToCssText, validatePageContent, type BlockNode } from '../src';

const n = (id: string, type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id, type, props, children });

describe('custom CSS box', () => {
  it('turns declarations into validated style props and reports the rest', () => {
    const res = parseCssDeclarations(`border-radius: 24px;
box-shadow: 0 12px 40px -12px rgba(0,0,0,0.4); backdrop-filter: blur(12px)
aspect-ratio: 16/9;
color: red;
background-image: url(https://evil.example/x.png);
position: fixed !important;
}body{display:none
nonsense
-webkit-thing: 1px;`);
    expect(res.props).toEqual({ borderRadius: '24px', boxShadow: '0 12px 40px -12px rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)', aspectRatio: '16/9', position: 'fixed' });
    const reasons = res.errors.map((e) => [e.line, e.reason]);
    expect(reasons).toContainEqual([4, 'invalid']); // named colours are not in the grammar
    expect(reasons).toContainEqual([5, 'invalid']); // url() never passes
    expect(reasons).toContainEqual([7, 'syntax']); // a selector, not a declaration
    expect(reasons).toContainEqual([8, 'syntax']);
    expect(reasons).toContainEqual([9, 'unknown']);
  });

  it('round-trips through CSS text and compiles only for the block, per breakpoint', () => {
    const props = parseCssDeclarations(stylesToCssText({ gridTemplateRows: 'auto 1fr', alignSelf: 'center', translateX: '4px' })).props;
    expect(props).toEqual({ gridTemplateRows: 'auto 1fr', alignSelf: 'center', translateX: '4px' });
    const css = compileStyles({ id: 'root', children: [{ id: 'b1', styles: { base: { order: '2' }, mobileS: { order: '-1', whiteSpace: 'nowrap' } }, children: [] }] });
    expect(css).toContain('[data-cn="b1"][data-cn]{order:2}');
    expect(css).toMatch(/@container \(max-width: 479px\)\{\[data-cn="b1"\]\[data-cn\]\{order:-1;white-space:nowrap\}\}/);
  });
});

describe('new canvas elements', () => {
  it('validates icons, badges, lists and image crops; refuses what the renderer can’t draw', () => {
    const ok = validatePageContent({
      root: n('root', 'section', {}, [
        n('i', 'icon', { name: 'rocket', size: 'lg', tone: 'primary', circle: true, align: 'center', label: 'Fast' }),
        n('b', 'badge', { text: '−20 %', tone: 'outline', align: 'left' }),
        n('l', 'list', { items: [{ text: 'One' }, { text: 'Two' }], marker: 'number', align: 'left' }),
        n('im', 'image', { mediaId: '', src: 'https://images.unsplash.com/photo-1', alt: '', caption: '', rounded: true, ratio: '16/9', fit: 'cover', focus: 'top', overlay: 'dark' }),
      ]),
    });
    expect(ok.ok).toBe(true);
    expect(validatePageContent({ root: n('root', 'section', {}, [n('i', 'icon', { name: 'skull-and-bones' })]) }).ok).toBe(false);
    expect(validatePageContent({ root: n('root', 'section', {}, [n('l', 'list', { items: [] })]) }).ok).toBe(false);
    expect(validatePageContent({ root: n('root', 'section', {}, [n('im', 'image', { ratio: '7/5' })]) }).ok).toBe(false);
  });
});
