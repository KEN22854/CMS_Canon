import type { BlockNode, PageContent } from '@canon/blocks';
import { describe, expect, it, vi } from 'vitest';
import { createBuilderStore, type Draft } from '../src/components/builder/store';
import { canContain, findNode, findParent, insertNear, isWithin, moveTo, newBlock } from '../src/components/editor/tree-ops';

const n = (id: string, type: string, children: BlockNode[] = [], props: Record<string, unknown> = {}): BlockNode => ({ id, type, props, children });
const page = (): PageContent => ({
  root: n('root', 'section', [n('hero', 'hero', [], { title: 'Hi' }), n('band', 'section', [n('h', 'heading', [], { text: 'A' })]), n('row', 'row', [n('c1', 'column', [n('t', 'text')]), n('c2', 'column')])]),
});
const draft = (content = page()): Draft => ({ title: 'T', slug: 't', description: '', seo: {}, content });

describe('tree ops', () => {
  it('enforces nesting rules', () => {
    const c = page();
    const row = findNode(c.root, 'row')!;
    expect(canContain(row, 'column', false)).toBe(true);
    expect(canContain(row, 'heading', false)).toBe(false);
    expect(canContain(c.root, 'column', true)).toBe(false);
    expect(canContain(findNode(c.root, 'band')!, 'section', false)).toBe(false);
    expect(canContain(findNode(c.root, 'hero')!, 'text', false)).toBe(false);
  });

  it('moves across parents, adjusts same-parent indexes and refuses cycles', () => {
    let c = moveTo(page(), 'h', 'c2', 0);
    expect(findParent(c.root, 'h')!.parent.id).toBe('c2');
    c = moveTo(c, 'hero', 'root', 2); // after "band": index counted before removal
    expect(c.root.children.map((x) => x.id)).toEqual(['band', 'hero', 'row']);
    expect(moveTo(c, 'row', 'c1', 0)).toBe(c); // into its own descendant
    expect(moveTo(c, 'c1', 'root', 0)).toBe(c); // a column outside Columns
    expect(isWithin(c.root, 'row', 't')).toBe(true);
  });

  it('inserts near the selection, walking up to a parent that accepts the block', () => {
    const c = insertNear(page(), 't', n('new', 'heading'));
    expect(findParent(c.root, 'new')).toMatchObject({ parent: { id: 'c1' }, index: 1 });
    const s = insertNear(page(), 't', n('sec', 'section'));
    expect(findParent(s.root, 'sec')).toMatchObject({ parent: { id: 'root' }, index: 3 });
    const intoCol = insertNear(page(), 'c2', n('x', 'image'));
    expect(findParent(intoCol.root, 'x')!.parent.id).toBe('c2');
  });

  it('new Columns come with two columns', () => {
    expect(newBlock('row').children.map((c) => c.type)).toEqual(['column', 'column']);
  });
});

describe('builder store', () => {
  it('undoes and redoes structural edits; dirty is a reference check', () => {
    const s = createBuilderStore(draft());
    const t = () => s.temporal.getState();
    s.getState().remove('hero');
    expect(s.getState().draft.content.root.children[0]!.id).toBe('band');
    expect(s.getState().draft).not.toBe(s.getState().saved);
    t().undo();
    expect(s.getState().draft.content.root.children[0]!.id).toBe('hero');
    expect(s.getState().draft).toBe(s.getState().saved);
    t().redo();
    expect(s.getState().draft.content.root.children[0]!.id).toBe('band');
  });

  it('coalesces typing in one field into a single undo step, but not across fields', () => {
    vi.useFakeTimers();
    const s = createBuilderStore(draft());
    for (const v of ['H', 'He', 'Hel', 'Hello']) {
      s.getState().updateProps('hero', { title: v }, 'hero.title');
      s.getState().hover('hero'); // UI state in between must not break coalescing
      vi.advanceTimersByTime(200);
    }
    s.getState().updateProps('h', { text: 'B' }, 'h.text');
    expect(s.temporal.getState().pastStates).toHaveLength(2);
    s.temporal.getState().undo(2);
    expect(findNode(s.getState().draft.content.root, 'hero')!.props.title).toBe('Hi');
    vi.useRealTimers();
  });

  it('selection never enters history, and reset clears it', () => {
    const s = createBuilderStore(draft());
    s.getState().select('row');
    s.getState().setBreakpoint('mobile');
    expect(s.temporal.getState().pastStates).toHaveLength(0);
    s.getState().duplicate('row');
    expect(s.getState().selectedId).not.toBe('row');
    expect(s.getState().draft.content.root.children).toHaveLength(4);
    s.getState().reset(draft());
    expect(s.temporal.getState().pastStates).toHaveLength(0);
  });
});
