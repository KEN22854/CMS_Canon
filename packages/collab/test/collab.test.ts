import { describe, expect, it } from 'vitest';
import { Y, applyDraftDiff, draftHash, draftToYDoc, isInitialized, yDocToDraft, type CollabDraft, type DraftNode } from '../src';

const n = (id: string, type: string, props: Record<string, unknown> = {}, children: DraftNode[] = []): DraftNode => ({ id, type, props, children });
const draft = (): CollabDraft => ({
  title: 'Pricing',
  slug: 'pricing',
  description: '',
  seo: {},
  content: { root: n('root', 'section', { paddingY: 'lg' }, [n('hero', 'hero', { title: 'A', ctaLabel: 'Go' }), n('row', 'row', {}, [n('c1', 'column', {}, [n('t', 'text', { doc: { type: 'doc', content: [] } })]), n('c2', 'column')])]) },
});

/** Two peers syncing by exchanging full state updates (what the server relays). */
function peers() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'));
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'));
  return { a, b };
}

describe('draft ⇄ Y.Doc', () => {
  it('round-trips a draft', () => {
    const doc = new Y.Doc();
    expect(isInitialized(doc)).toBe(false);
    draftToYDoc(doc, draft());
    expect(isInitialized(doc)).toBe(true);
    expect(yDocToDraft(doc)).toEqual(draft());
  });

  it('applies minimal diffs: props, moves, inserts, deletes', () => {
    const doc = new Y.Doc();
    const d0 = draft();
    draftToYDoc(doc, d0);
    const d1: CollabDraft = JSON.parse(JSON.stringify(d0));
    d1.title = 'Plans';
    d1.content.root.children[0]!.props.title = 'B';
    d1.content.root.children.push(n('cta', 'cta', { title: 'Go' }));
    d1.content.root.children[1]!.children[1]!.children.push(d1.content.root.children[1]!.children[0]!.children.pop()!); // move text c1 → c2
    let updates = 0;
    doc.on('update', () => updates++);
    applyDraftDiff(doc, d0, d1);
    expect(updates).toBe(1); // one transaction
    expect(yDocToDraft(doc)).toEqual(d1);
    const d2: CollabDraft = JSON.parse(JSON.stringify(d1));
    d2.content.root.children.splice(1, 1); // delete the row and its subtree
    applyDraftDiff(doc, d1, d2);
    expect(yDocToDraft(doc)).toEqual(d2);
    expect(doc.getMap('blocks').has('c1')).toBe(false);
  });
});

describe('concurrent editing', () => {
  it('merges edits to different props of the same block, and a structural edit elsewhere', () => {
    const { a, b } = peers();
    draftToYDoc(a, draft());
    const base = yDocToDraft(b)!;
    // Offline edits on both sides, then they sync.
    const da: CollabDraft = JSON.parse(JSON.stringify(base));
    da.content.root.children[0]!.props.title = 'Title from A';
    const db: CollabDraft = JSON.parse(JSON.stringify(base));
    db.content.root.children[0]!.props.ctaLabel = 'Button from B';
    db.content.root.children.push(n('quote', 'quote', { text: 'Hi' }));
    const sa = Y.encodeStateAsUpdate(a);
    const sb = Y.encodeStateAsUpdate(b);
    const offA = new Y.Doc();
    const offB = new Y.Doc();
    Y.applyUpdate(offA, sa);
    Y.applyUpdate(offB, sb);
    applyDraftDiff(offA, base, da);
    applyDraftDiff(offB, base, db);
    Y.applyUpdate(offA, Y.encodeStateAsUpdate(offB));
    Y.applyUpdate(offB, Y.encodeStateAsUpdate(offA));
    const merged = yDocToDraft(offA)!;
    expect(merged).toEqual(yDocToDraft(offB));
    expect(merged.content.root.children[0]!.props).toMatchObject({ title: 'Title from A', ctaLabel: 'Button from B' });
    expect(merged.content.root.children.map((c) => c.id)).toContain('quote');
  });

  it('keeps a valid tree when concurrent moves list a block under two parents', () => {
    const doc = new Y.Doc();
    draftToYDoc(doc, draft());
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    (blocks.get('c2')!.get('children') as Y.Array<string>).push(['t']); // "t" now under c1 AND c2
    (blocks.get('root')!.get('children') as Y.Array<string>).push(['ghost']); // dangling id
    const d = yDocToDraft(doc)!;
    const ids: string[] = [];
    const walk = (x: DraftNode) => (ids.push(x.id), x.children.forEach(walk));
    walk(d.content.root);
    expect(ids.filter((i) => i === 't')).toHaveLength(1);
    expect(ids).not.toContain('ghost');
  });

  it('hashes drafts stably', () => {
    expect(draftHash(draft())).toBe(draftHash(draft()));
    const d = draft();
    d.title = 'x';
    expect(draftHash(d)).not.toBe(draftHash(draft()));
  });

  it('hashes independent of key order (Y.Map vs plain objects)', () => {
    const a = draft();
    const b = draft();
    b.content.root.children[0]!.props = { ctaLabel: 'Go', title: 'A' };
    expect(draftHash(a)).toBe(draftHash(b));
    const doc = new Y.Doc();
    draftToYDoc(doc, a);
    expect(draftHash(yDocToDraft(doc)!)).toBe(draftHash(a));
  });
});
