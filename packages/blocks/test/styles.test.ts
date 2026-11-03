import { describe, expect, it } from 'vitest';
import { compileStyles, isValidStyleValue, resolveStyles, setStyle, styleSource, validatePageContent, validateStyles, type ResponsiveStyles } from '../src';

describe('style values', () => {
  it('accepts the grammar of each property', () => {
    for (const [p, v] of [
      ['marginTop', '-12px'],
      ['maxWidth', 'none'],
      ['gap', '16px 2rem'],
      ['gridTemplateColumns', 'repeat(auto-fit, minmax(240px, 1fr))'],
      ['gridTemplateColumns', '1fr 2fr'],
      ['color', '#8B7CFF'],
      ['color', 'rgb(139 124 255 / 0.5)'],
      ['backgroundColor', 'token:primary'],
      ['backgroundImage', 'linear-gradient(135deg, #8B7CFF, #42C8E8 80%)'],
      ['boxShadow', '0 8px 24px -4px rgba(0,0,0,0.3)'],
      ['borderRadius', '12px 12px 0 0'],
      ['lineHeight', '1.4'],
      ['filter', 'blur(4px) grayscale(50%)'],
      ['rotate', '-8deg'],
      ['scale', '1.05'],
      ['fontFamily', 'serif'],
    ] as const) {
      expect(isValidStyleValue(p, v), `${p}: ${v}`).toBe(true);
    }
  });

  it('rejects injection and malformed values', () => {
    for (const [p, v] of [
      ['color', 'red;background:url(javascript:alert(1))'],
      ['backgroundImage', 'url(https://evil.example/x.png)'],
      ['width', '10px}body{display:none'],
      ['color', 'expression(alert(1))'],
      ['boxShadow', '0 0 0 red</style><script>'],
      ['fontFamily', 'Comic Sans'],
      ['color', '#12'],
      ['opacity', '2'],
      ['zIndex', '1e9'],
      ['unknownProp', '1px'],
    ] as const) {
      expect(isValidStyleValue(p, v), `${p}: ${v}`).toBe(false);
    }
  });
});

describe('responsive resolution', () => {
  const styles = { base: { fontSize: '48px', color: '#111111' }, tablet: { fontSize: '36px' }, mobileS: { fontSize: '28px' } };

  it('inherits desktop first and overrides per breakpoint', () => {
    expect(resolveStyles(styles, 'base')).toEqual({ fontSize: '48px', color: '#111111' });
    expect(resolveStyles(styles, 'laptop').fontSize).toBe('48px');
    expect(resolveStyles(styles, 'mobileL')).toEqual({ fontSize: '36px', color: '#111111' });
    expect(resolveStyles(styles, 'mobileS').fontSize).toBe('28px');
    expect(styleSource(styles, 'mobileL', 'fontSize')).toBe('tablet');
    expect(styleSource(styles, 'mobileL', 'color')).toBe('base');
  });

  it('editing a smaller breakpoint never touches desktop', () => {
    const next = setStyle(styles, 'mobileL', 'color', '#ff0000');
    expect(next?.base).toEqual(styles.base);
    expect(resolveStyles(next, 'base').color).toBe('#111111');
    expect(resolveStyles(next, 'mobileS').color).toBe('#ff0000');
    expect(setStyle({ tablet: { fontSize: '36px' } }, 'tablet', 'fontSize', '')).toBeUndefined();
  });
});

describe('compiler', () => {
  it('emits base rules and only the changes inside container queries', () => {
    const css = compileStyles({
      id: 'root',
      children: [
        { id: 'h1', styles: { base: { fontSize: '48px', backgroundColor: 'token:primary', rotate: '-2deg', scale: '1.1' }, tablet: { fontSize: '36px' } }, children: [] },
        { id: 'p', styles: { mobileL: { display: 'none' } }, children: [] },
      ],
    });
    expect(css).toContain('[data-cn="h1"][data-cn]{font-size:48px;background-color:rgb(var(--site-primary));transform:rotate(-2deg) scale(1.1)}');
    expect(css).toContain('@container (max-width: 991px){[data-cn="h1"][data-cn]{font-size:36px}}');
    expect(css).toContain('@container (max-width: 767px){[data-cn="p"][data-cn]{display:none}}');
    // Unchanged properties are not repeated below.
    expect(css.match(/background-color/g)).toHaveLength(1);
  });

  it('reuses compiled rules but reflects every new styles object', () => {
    const a: ResponsiveStyles = { base: { color: '#111111' } };
    const tree = (s: typeof a) => ({ id: 'root', children: [{ id: 'x', styles: s, children: [] }, { id: 'y', styles: s, children: [] }] });
    expect(compileStyles(tree(a))).toBe('[data-cn="x"][data-cn]{color:#111111}\n[data-cn="y"][data-cn]{color:#111111}');
    // Same object, different node id and root position: cache keys keep them apart.
    expect(compileStyles({ id: 'x', styles: a, children: [] })).toBe('[data-cn="x"][data-cn]{color:#111111}');
    const b = setStyle(a, 'tablet', 'color', '#222222')!;
    expect(compileStyles(tree(b))).toContain('@container (max-width: 991px){[data-cn="x"][data-cn]{color:#222222}');
  });
});

describe('document validation', () => {
  const page = (styles: unknown) => ({ root: { id: 'root', type: 'section', props: {}, children: [{ id: 'h', type: 'heading', props: { text: 'Hi' }, name: 'Title', locked: false, styles }] } });

  it('keeps valid styles and node meta', () => {
    const res = validatePageContent(page({ base: { color: '#222222' } }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const h = res.content.root.children[0]!;
      expect(h.styles).toEqual({ base: { color: '#222222' } });
      expect(h.name).toBe('Title');
      expect('locked' in h).toBe(false); // false flags are not stored
    }
  });

  it('rejects unsafe styles on save', () => {
    const res = validatePageContent(page({ base: { color: 'red;x:url(javascript:1)' }, giant: {} }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Invalid value for color', 'Unknown breakpoint "giant"']));
    expect(validateStyles('nope').issues[0]!.message).toBe('Styles must be an object');
  });
});
