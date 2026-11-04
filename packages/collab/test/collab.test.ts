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

describe('node meta and styles', () => {
  it('round-trips names, flags and responsive styles, and diffs them', () => {
    const doc = new Y.Doc();
    const d0 = draft();
    d0.content.root.children[0] = { ...d0.content.root.children[0]!, name: 'Main hero', locked: true, styles: { base: { paddingTop: '96px' }, mobileL: { paddingTop: '24px' } } };
    draftToYDoc(doc, d0);
    expect(yDocToDraft(doc)).toEqual(d0);

    const d1: CollabDraft = JSON.parse(JSON.stringify(d0));
    const hero = d1.content.root.children[0]!;
    delete hero.locked;
    hero.hidden = true;
    hero.styles = { base: { paddingTop: '80px', color: '#222222' } }; // mobile override removed
    applyDraftDiff(doc, d0, d1);
    expect(yDocToDraft(doc)).toEqual(d1);
  });

  it('merges two people styling different properties of one block', () => {
    const base = draft();
    const a = new Y.Doc();
    draftToYDoc(a, base);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const da: CollabDraft = JSON.parse(JSON.stringify(base));
    da.content.root.children[0]!.styles = { base: { fontSize: '40px' } };
    const db: CollabDraft = JSON.parse(JSON.stringify(base));
    db.content.root.children[0]!.styles = { tablet: { marginTop: '8px' } };
    applyDraftDiff(a, base, da);
    applyDraftDiff(b, base, db);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(yDocToDraft(a)!.content.root.children[0]!.styles).toEqual({ base: { fontSize: '40px' }, tablet: { marginTop: '8px' } });
    expect(yDocToDraft(b)).toEqual(yDocToDraft(a));
  });
});

describe('animations in co-editing', () => {
  it('round-trips a block animation and drops a malformed one', () => {
    const doc = new Y.Doc();
    const draft = { title: 'T', slug: 't', description: '', seo: {}, content: { root: { id: 'r', type: 'section', props: {}, children: [{ id: 'h', type: 'heading', props: { text: 'Hi' }, children: [], animation: { type: 'slide-up', delay: 200 } }] } } };
    draftToYDoc(doc, draft);
    expect(yDocToDraft(doc)!.content.root.children[0]!.animation).toEqual({ type: 'slide-up', delay: 200 });
    const next = structuredClone(draft);
    next.content.root.children[0]!.animation = { type: 'zoom-in' } as never;
    applyDraftDiff(doc, draft, next);
    expect(yDocToDraft(doc)!.content.root.children[0]!.animation).toEqual({ type: 'zoom-in' });
    (doc.getMap('blocks').get('h') as Y.Map<unknown>).set('animation', '{not json');
    expect(yDocToDraft(doc)!.content.root.children[0]!.animation).toBeUndefined();
  });
});

describe('board fields in co-editing', () => {
  it('syncs HTML attributes and interaction-state styles like any other edit', () => {
    const doc = new Y.Doc();
    const draft = { title: 'T', slug: 't', description: '', seo: {}, content: { root: { id: 'r', type: 'section', props: {}, children: [{ id: 'b', type: 'button', props: { label: 'Go' }, children: [], attrs: { id: 'go' }, styles: { base: { color: '#111111' }, hover: { color: '#222222' } } }] } } };
    draftToYDoc(doc, draft);
    const back = yDocToDraft(doc)!.content.root.children[0]!;
    expect(back.attrs).toEqual({ id: 'go' });
    expect(back.styles).toEqual({ base: { color: '#111111' }, hover: { color: '#222222' } });
    const next = structuredClone(draft);
    next.content.root.children[0]!.attrs = { id: 'go', title: 'Start' } as never;
    (next.content.root.children[0]!.styles as Record<string, Record<string, string>>).active = { opacity: '0.8' };
    applyDraftDiff(doc, draft, next);
    const after = yDocToDraft(doc)!.content.root.children[0]!;
    expect(after.attrs).toEqual({ id: 'go', title: 'Start' });
    expect(after.styles).toMatchObject({ hover: { color: '#222222' }, active: { opacity: '0.8' } });
  });
});
