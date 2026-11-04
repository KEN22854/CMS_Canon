import { describe, expect, it } from 'vitest';
import { ANIMATION_CSS, animationSchema, compileStyles, expandStagger, normalizeAnimation, validatePageContent } from '../src';

const page = (animation: unknown) => ({ root: { id: 'root', type: 'section', props: {}, children: [{ id: 'h', type: 'heading', props: { text: 'Hi' }, children: [], animation }] } });

describe('block animations', () => {
  it('keeps valid animations minimal and refuses unknown values', () => {
    const ok = validatePageContent(page({ type: 'slide-up', trigger: 'scroll', duration: 700, delay: 150, hover: 'lift' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.content.root.children[0]!.animation).toEqual({ type: 'slide-up', delay: 150, hover: 'lift' }); // defaults dropped
    expect(validatePageContent(page({ type: 'explode' })).ok).toBe(false);
    expect(validatePageContent(page({ type: 'fade', duration: 99999 })).ok).toBe(false);
    expect(validatePageContent(page({ type: 'fade', onEnd: 'alert(1)' })).ok).toBe(false); // strict: no extra keys
    expect(normalizeAnimation({ trigger: 'load' })).toBeUndefined();
  });

  it('compiles timing per block and ships keyframes that respect reduced motion', () => {
    const css = compileStyles({ id: 'root', children: [{ id: 'h', animation: { type: 'zoom-in', duration: 400, delay: 100, easing: 'spring' }, children: [] }] });
    expect(css).toContain('[data-cn="h"][data-anim]{--anim-dur:400ms;--anim-delay:100ms;--anim-ease:cubic-bezier(0.34, 1.56, 0.64, 1)}');
    expect(ANIMATION_CSS).toContain('@keyframes canon-zoom-in');
    expect(ANIMATION_CSS).toContain('prefers-reduced-motion:reduce');
    expect(ANIMATION_CSS).toContain('.canon-anim [data-anim-trigger="scroll"]:not([data-anim-in])');
  });
});

describe('staggered entrances', () => {
  const n = (id: string, animation?: object, children: { id: string; animation?: object; children: never[] }[] = []) => ({ id, animation, children }) as never;
  it('spells out one entrance per child, growing delays; own entrances and hover kept', () => {
    const grid = n('g', { type: 'slide-up', delay: 100, stagger: 150, hover: 'lift', duration: 500 }, [n('a'), n('b', { hover: 'grow' }), n('c', { type: 'fade' }), n('d')]);
    const out = expandStagger(grid) as unknown as { animation?: object; children: { animation?: object }[] };
    expect(out.animation).toEqual({ hover: 'lift' }); // the container itself doesn't move
    expect(out.children.map((c) => c.animation)).toEqual([
      { type: 'slide-up', duration: 500, delay: 100 },
      { type: 'slide-up', duration: 500, delay: 250, hover: 'grow' },
      { type: 'fade' },
      { type: 'slide-up', duration: 500, delay: 550 },
    ]);
    expect(animationSchema.safeParse({ type: 'fade', stagger: 10 }).success).toBe(false); // 50 ms at least
    const plain = n('p', undefined, [n('x')]);
    expect(expandStagger(plain)).toBe(plain); // untouched trees keep their identity
  });
});
