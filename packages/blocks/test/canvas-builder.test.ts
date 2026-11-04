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

describe('interaction states', () => {
  it('compiles hover / pressed / focus layers; a Button’s colours and states style its link', () => {
    const tree = {
      id: 'root',
      children: [
        { id: 'card', type: 'group', styles: { base: { borderRadius: '16px', transitionDuration: '200ms' }, hover: { boxShadow: '0 8px 24px 0 rgba(0,0,0,0.2)', translateY: '-4px' } }, children: [] },
        { id: 'cta', type: 'button', styles: { base: { backgroundColor: '#111111', marginTop: '24px' }, hover: { backgroundColor: '#333333' }, active: { scale: '0.98' }, focus: { borderColor: 'token:primary', borderWidth: '2px', borderStyle: 'solid' }, mobileS: { backgroundColor: '#222222' } }, children: [] },
      ],
    };
    const css = compileStyles(tree);
    expect(css).toContain('[data-cn="card"][data-cn]{border-radius:16px;transition:all 200ms ease}');
    expect(css).toContain('[data-cn="card"][data-cn]:hover{box-shadow:0 8px 24px 0 rgba(0,0,0,0.2);transform:translate(0, -4px)}');
    // Layout stays on the block, the look moves to the button itself — also per breakpoint.
    expect(css).toContain('[data-cn="cta"][data-cn]{margin-top:24px}[data-cn="cta"][data-cn] [data-cn-el]{background-color:#111111}');
    expect(css).toContain('[data-cn="cta"][data-cn] [data-cn-el]:hover{background-color:#333333}');
    expect(css).toContain('[data-cn="cta"][data-cn] [data-cn-el]:active{transform:scale(0.98)}');
    expect(css).toContain('[data-cn="cta"][data-cn] [data-cn-el]:focus-visible{border-color:rgb(var(--site-primary));border-width:2px;border-style:solid}');
    expect(css).toMatch(/@container \(max-width: 479px\)\{\[data-cn="cta"\]\[data-cn\] \[data-cn-el\]\{background-color:#222222\}\}/);
  });

  it('accepts state layers in page content and refuses unknown ones', () => {
    const page = (styles: unknown) => ({ root: n('root', 'section', {}, [{ ...n('b', 'button', { label: 'Go', href: '/', variant: 'primary', align: 'left', size: 'lg' }), styles } as BlockNode]) });
    expect(validatePageContent(page({ hover: { color: '#ffffff' }, focus: { opacity: '0.9' } })).ok).toBe(true);
    expect(validatePageContent(page({ pressed: { color: '#ffffff' } })).ok).toBe(false);
    expect(validatePageContent(page({ hover: { transitionDuration: '9000ms' } })).ok).toBe(false);
  });
});

describe('HTML attributes', () => {
  it('keeps the allowlist (anchor id, label, tooltip) and refuses anything else', () => {
    const page = (attrs: unknown) => ({ root: n('root', 'section', {}, [{ ...n('h', 'heading', { text: 'Hi', level: 2, align: 'left' }), attrs } as BlockNode]) });
    const ok = validatePageContent(page({ id: 'pricing', ariaLabel: 'Prices', title: '' }));
    expect(ok.ok && ok.content.root.children[0]!.attrs).toEqual({ id: 'pricing', ariaLabel: 'Prices' });
    expect(validatePageContent(page({ onclick: 'alert(1)' })).ok).toBe(false);
    expect(validatePageContent(page({ id: '1-bad' })).ok).toBe(false);
    expect(validatePageContent(page({ id: 'x" onmouseover="y' })).ok).toBe(false);
    expect(validatePageContent(page({})).ok && validatePageContent(page({})).ok).toBe(true);
  });
});
