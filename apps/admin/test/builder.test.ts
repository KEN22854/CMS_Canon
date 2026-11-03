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

describe('Builder 2.0 store: selection, clipboard, groups, operation log', () => {
  it('multi-selects, groups siblings and ungroups them', () => {
    const s = createBuilderStore(draft({ root: n('root', 'section', [n('a', 'heading', [], { text: 'A', level: 2 }), n('b', 'heading', [], { text: 'B', level: 2 }), n('c', 'heading', [], { text: 'C', level: 2 })]) }));
    const st = () => s.getState();
    st().select('a');
    st().toggleSelect('c');
    expect(st().selectedIds).toEqual(['a', 'c']);
    expect(st().selectedId).toBe('c');
    st().group();
    const g = st().draft.content.root.children.find((x) => x.type === 'group')!;
    expect(g.children.map((x) => x.id)).toEqual(['a', 'c']);
    expect(st().selectedIds).toEqual([g.id]);
    st().ungroup(g.id);
    expect(st().draft.content.root.children.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(st().opLog.map((e) => e.op)).toEqual(['NODE_GROUP', 'NODE_UNGROUP']);
  });

  it('copies, pastes with new ids and deletes the whole selection', () => {
    const s = createBuilderStore(draft());
    const st = () => s.getState();
    st().select('hero');
    st().toggleSelect('band');
    expect(st().copy()).toBe(2);
    st().select('row');
    expect(st().paste()).toBe(2);
    const ids = st().draft.content.root.children.map((x) => x.id);
    expect(ids).toHaveLength(5);
    expect(ids.slice(0, 3)).toEqual(['hero', 'band', 'row']);
    expect(ids.slice(3)).not.toContain('hero'); // fresh ids
    st().removeSelection();
    expect(st().draft.content.root.children.map((x) => x.id)).toEqual(['hero', 'band', 'row']);
    // One undo step per operation.
    s.temporal.getState().undo();
    expect(st().draft.content.root.children).toHaveLength(5);
  });

  it('logs typed operations and coalesces typing into one entry', () => {
    vi.useFakeTimers();
    const s = createBuilderStore(draft());
    s.getState().updateProps('h', { text: 'Ab' }, 'h.text');
    s.getState().updateProps('h', { text: 'Abc' }, 'h.text');
    vi.advanceTimersByTime(2_000);
    s.getState().updateNode('h', { hidden: true });
    expect(s.getState().opLog.map((e) => [e.op, e.label])).toEqual([
      ['PROPS_UPDATE', 'Edit Heading: text'],
      ['NODE_META', 'Hide Heading'],
    ]);
    vi.useRealTimers();
  });

  it('refuses inserts past the server cap instead of failing on save', () => {
    const many = Array.from({ length: 2998 }, (_, i) => n(`h${i}`, 'heading', [], { text: 'x', level: 2 }));
    const s = createBuilderStore(draft({ root: n('root', 'section', many) }));
    s.getState().select('h0');
    expect(s.getState().copy()).toBe(1);
    expect(s.getState().paste()).toBe(1); // 3 000 blocks with the root: still fine
    expect(s.getState().paste()).toBe(0);
    expect(s.getState().limitHit).not.toBeNull();
    s.getState().duplicate('h1');
    expect(s.getState().draft.content.root.children).toHaveLength(2999);
  });
});
