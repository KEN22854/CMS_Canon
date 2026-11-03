import { describe, expect, it } from 'vitest';
import { applyOperations, buildPlan, findNode, outlineForPlan, type BlockNode, type PageContent } from '../src';

const h = (id: string, text: string, extra: Partial<BlockNode> = {}): BlockNode => ({ id, type: 'heading', props: { text, level: 2, align: 'left' }, children: [], ...extra });
const page = (): PageContent => ({
  root: { id: 'root', type: 'section', props: {}, children: [{ id: 's1', type: 'section', props: {}, children: [h('h1', 'Old title'), h('h2', 'Second')] }, h('lock', 'Legal', { locked: true })] },
});

describe('AI edit plans', () => {
  it('accepts valid operations in order and builds the resulting page', () => {
    const plan = buildPlan(
      {
        summary: 'Sharper headline, bigger on desktop, plus an FAQ.',
        operations: [
          { op: 'PROPS_UPDATE', id: 'h1', patch: { text: 'Ship faster' } },
          { op: 'STYLE_SET', id: 'h1', property: 'fontSize', value: '48px' },
          { op: 'NODE_INSERT', parentId: 's1', index: 2, nodes: [{ type: 'faq', props: { title: 'Questions', items: [{ q: 'Price?', a: 'It is {{fact:pro.price}}.' }] } }] },
          { op: 'NODE_MOVE', id: 'h2', parentId: 's1', index: 0 },
        ],
      },
      page(),
      { facts: { 'pro.price': '$59' } },
    );
    expect(plan.summary).toBe('Sharper headline, bigger on desktop, plus an FAQ.');
    expect(plan.operations.map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(plan.operations[0]!.label).toBe('Edit Heading: text');
    const s1 = findNode(plan.content.root, 's1')!;
    expect(s1.children.map((c) => c.type)).toEqual(['heading', 'heading', 'faq']);
    expect(findNode(plan.content.root, 'h1')!.styles).toEqual({ base: { fontSize: '48px' } });
    // New blocks get fresh ids; facts in plain fields resolve to their value.
    const faq = s1.children[2]!;
    expect(faq.id).not.toBe('faq');
    expect((faq.props.items as { a: string }[])[0]!.a).toBe('It is $59.');
    // The client can replay the accepted operations and get the same page.
    expect(applyOperations(page(), plan.operations.map((o) => o.operation))).toEqual(plan.content);
  });

  it('rejects what is unsafe, unknown or impossible, and keeps the rest', () => {
    const plan = buildPlan(
      {
        operations: [
          { op: 'STYLE_SET', id: 'h1', property: 'color', value: 'red;background:url(javascript:1)' },
          { op: 'STYLE_SET', id: 'h1', property: 'behavior', value: 'x' },
          { op: 'PROPS_UPDATE', id: 'h1', patch: { onclick: 'alert(1)' } },
          { op: 'PROPS_UPDATE', id: 'h1', patch: { level: 9 } },
          { op: 'PROPS_UPDATE', id: 'ghost', patch: { text: 'x' } },
          { op: 'NODE_REMOVE', ids: ['lock'] },
          { op: 'NODE_LOCK', id: 'h1' },
          { op: 'NODE_INSERT', parentId: 'h1', index: 0, nodes: [{ type: 'text', props: {} }] },
          { op: 'NODE_INSERT', parentId: 's1', index: 0, nodes: [{ type: 'button', props: { label: 'x', href: 'javascript:alert(1)' } }] },
          { op: 'PROPS_UPDATE', id: 'h2', patch: { text: 'Kept' } },
        ],
      },
      page(),
    );
    expect(plan.operations.map((o) => o.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'ok']);
    expect(plan.operations[0]!.reason).toBe('Invalid value for color');
    expect(plan.operations[2]!.reason).toContain('has no field "onclick"');
    expect(plan.operations[5]!.reason).toContain('locked');
    expect(findNode(plan.content.root, 'h2')!.props.text).toBe('Kept');
    expect(findNode(plan.content.root, 'lock')).not.toBeNull();
  });

  it('tolerates garbage and caps the number of operations', () => {
    expect(buildPlan('nope', page()).operations).toEqual([]);
    const many = buildPlan({ operations: Array.from({ length: 50 }, () => ({ op: 'NODE_DUPLICATE', id: 'h2' })) }, page());
    expect(many.operations).toHaveLength(30);
  });

  it('describes the page compactly for the prompt', () => {
    const outline = outlineForPlan(page().root);
    expect(outline).toContain('- h1 heading : "Old title"');
    expect(outline).toContain('- lock heading : "Legal" (locked)');
  });
});
