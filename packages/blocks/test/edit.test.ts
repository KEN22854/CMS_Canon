import { describe, expect, it } from 'vitest';
import { applyOperation, applyOperations, collectComponentIds, componentTreeIssues, describeOperation, expandComponents, findNode, groupBlocks, normalizeSelection, ungroupBlock, validatePageContent, type BlockNode, type EditorOperation, type PageContent } from '../src';

const n = (id: string, type = 'heading', children: BlockNode[] = [], extra: Partial<BlockNode> = {}): BlockNode => ({ id, type, props: type === 'heading' ? { text: id, level: 2 } : {}, children, ...extra });
const page = (): PageContent => ({ root: n('root', 'section', [n('s1', 'section', [n('a'), n('b'), n('c')]), n('s2', 'section', [n('d', 'heading', [], { locked: true })])]) });
const ids = (b: BlockNode) => b.children.map((c) => c.id);

describe('typed operations', () => {
  it('insert, move, remove and keep untouched subtrees by identity', () => {
    const p = page();
    const ins = applyOperation(p, { op: 'NODE_INSERT', parentId: 's1', index: 1, nodes: [n('x')] });
    expect(ids(findNode(ins.root, 's1')!)).toEqual(['a', 'x', 'b', 'c']);
    expect(ins.root.children[1]).toBe(p.root.children[1]); // s2 untouched
    const moved = applyOperation(ins, { op: 'NODE_MOVE', id: 'x', parentId: 's2', index: 0 });
    expect(ids(findNode(moved.root, 's2')!)).toEqual(['x', 'd']);
    const removed = applyOperation(moved, { op: 'NODE_REMOVE', ids: ['a', 'b'] });
    expect(ids(findNode(removed.root, 's1')!)).toEqual(['c']);
  });

  it('refuses edits that break nesting rules or touch locked blocks', () => {
    const p = page();
    expect(applyOperation(p, { op: 'NODE_INSERT', parentId: 'a', index: 0, nodes: [n('x')] })).toBe(p); // heading isn't a container
    expect(applyOperation(p, { op: 'NODE_INSERT', parentId: 's1', index: 0, nodes: [n('col', 'column')] })).toBe(p);
    expect(applyOperation(p, { op: 'NODE_REMOVE', ids: ['d'] })).toBe(p);
    expect(applyOperation(p, { op: 'STYLE_SET', id: 'd', breakpoint: 'base', property: 'color', value: '#000000' })).toBe(p);
    // Unlocking is allowed, and then the edit goes through.
    const unlocked = applyOperation(p, { op: 'NODE_META', id: 'd', patch: { locked: undefined } });
    expect(findNode(applyOperation(unlocked, { op: 'NODE_REMOVE', ids: ['d'] }).root, 'd')).toBeNull();
  });

  it('sets and resets styles per breakpoint', () => {
    let p = applyOperation(page(), { op: 'STYLE_SET', id: 'a', breakpoint: 'tablet', property: 'fontSize', value: '20px' });
    expect(findNode(p.root, 'a')!.styles).toEqual({ tablet: { fontSize: '20px' } });
    p = applyOperation(p, { op: 'STYLE_SET', id: 'a', breakpoint: 'tablet', property: 'fontSize', value: null });
    expect('styles' in findNode(p.root, 'a')!).toBe(false);
  });

  it('gives the same tree back for an edit that sets what is already there', () => {
    // Otherwise "align" on aligned elements would be an undo step that changes nothing.
    const p = applyOperation(page(), { op: 'STYLE_SET', id: 'a', breakpoint: 'base', property: 'left', value: '40px' });
    expect(applyOperation(p, { op: 'STYLE_SET', id: 'a', breakpoint: 'base', property: 'left', value: ' 40px ' })).toBe(p);
    expect(applyOperation(p, { op: 'STYLE_SET', id: 'a', breakpoint: 'tablet', property: 'left', value: null })).toBe(p);
    expect(applyOperation(p, { op: 'PROPS_UPDATE', id: 'a', patch: { text: 'a' } })).toBe(p);
    expect(applyOperation(p, { op: 'NODE_META', id: 'a', patch: { hidden: false, styles: { base: { left: '40px' } } } })).toBe(p);
    expect(applyOperations(p, [{ op: 'STYLE_SET', id: 'a', breakpoint: 'base', property: 'left', value: '40px' }, { op: 'PROPS_UPDATE', id: 'b', patch: { level: 2 } }])).toBe(p);
    // A real change still goes through.
    expect(findNode(applyOperation(p, { op: 'PROPS_UPDATE', id: 'a', patch: { text: 'b' } }).root, 'a')!.props.text).toBe('b');
  });

  it('groups siblings into a Group and ungroups them back', () => {
    const p = page();
    const g = applyOperation(p, { op: 'NODE_GROUP', ids: ['c', 'b'], wrapper: n('g', 'group') });
    expect(ids(findNode(g.root, 's1')!)).toEqual(['a', 'g']);
    expect(ids(findNode(g.root, 'g')!)).toEqual(['b', 'c']); // document order, not click order
    expect(validatePageContent(g).ok).toBe(true);
    const u = ungroupBlock(g, 'g');
    expect(ids(findNode(u.root, 's1')!)).toEqual(['a', 'b', 'c']);
    // Different parents can't be grouped.
    expect(groupBlocks(p, ['a', 'd'])).toBe(p);
  });

  it('normalizes a selection: drops the root and blocks inside selected ones', () => {
    expect(normalizeSelection(page().root, ['root', 'b', 's1', 'd'])).toEqual(['s1', 'd']);
  });

  it('applies a batch and describes each operation', () => {
    const ops: EditorOperation[] = [
      { op: 'NODE_INSERT', parentId: 's1', index: 0, nodes: [n('x')] },
      { op: 'PROPS_UPDATE', id: 'x', patch: { text: 'Hello' } },
    ];
    const p = applyOperations(page(), ops);
    expect(findNode(p.root, 'x')!.props.text).toBe('Hello');
    expect(describeOperation(ops[1]!, p.root)).toBe('Edit Heading: text');
    expect(describeOperation({ op: 'NODE_GROUP', ids: ['a', 'b'] })).toBe('Group 2 blocks');
  });
});

describe('global components', () => {
  const header = n('hdr', 'group', [n('logo'), n('tag')]);
  const instance = (id: string, extra: Partial<BlockNode> = {}): BlockNode => ({ id, type: 'component', props: { componentId: 'cmp1', overrides: { tag: { text: `Tagline ${id}` } } }, children: [], ...extra });

  it('expands each instance with unique ids, overrides and the instance styles', () => {
    const content: PageContent = { root: n('root', 'section', [instance('i1', { styles: { base: { paddingTop: '8px' } } }), instance('i2', { hidden: true }), { id: 'gone', type: 'component', props: { componentId: 'missing' }, children: [] }]) };
    expect(collectComponentIds(content.root)).toEqual(['cmp1', 'missing']);
    const out = expandComponents(content, { cmp1: header });
    const [a, b] = out.root.children;
    expect(out.root.children).toHaveLength(2); // the missing component renders nothing
    expect(a!.id).toBe('i1');
    expect(a!.type).toBe('group');
    expect(a!.styles).toEqual({ base: { paddingTop: '8px' } });
    expect(ids(a!)).toEqual(['i1-logo', 'i1-tag']);
    expect(a!.children[1]!.props.text).toBe('Tagline i1');
    expect(b!.hidden).toBe(true);
    expect(validatePageContent(out).ok).toBe(true);
  });

  it('ignores overrides that would make props invalid', () => {
    const out = expandComponents({ root: n('root', 'section', [{ id: 'i', type: 'component', props: { componentId: 'cmp1', overrides: { logo: { level: 99 } } }, children: [] }]) }, { cmp1: header });
    expect(out.root.children[0]!.children[0]!.props.level).toBe(2);
  });

  it('rejects recursive or column-rooted components', () => {
    expect(componentTreeIssues(n('g', 'group', [instance('x')]))).toEqual(['Components cannot contain other components']);
    expect(componentTreeIssues(n('c', 'column'))).toHaveLength(1);
    expect(componentTreeIssues(header)).toEqual([]);
  });
});
