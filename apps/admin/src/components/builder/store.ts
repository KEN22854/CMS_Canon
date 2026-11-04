import { MAX_NODES, applyOperation, describeOperation, insertionPoint, normalizeSelection, type BlockNode, type EditorOperation, type PageContent, type StyleBreakpoint } from '@canon/blocks';
import { useStore } from 'zustand';
import { temporal } from 'zundo';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createContext, useContext } from 'react';
import type { PageDetail } from '@/lib/content';
import { canContain, cloneWithIds, findNode, findParent, newBlock, type NodeMeta } from '../editor/tree-ops';

export interface Draft {
  title: string;
  slug: string;
  description: string;
  seo: PageDetail['seo'];
  content: PageContent;
}

/** The style breakpoint being edited and previewed (see @canon/blocks STYLE_BREAKPOINTS). */
export type Breakpoint = StyleBreakpoint;

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;

export interface BuilderState {
  /** The only undoable slice. Every edit replaces it immutably, so "dirty" is a reference check. */
  draft: Draft;
  /** The draft object last acknowledged by the server. */
  saved: Draft;
  /** The primary selection (inspector, keyboard); always the last of `selectedIds`. */
  selectedId: string | null;
  /** Multi-selection (Ctrl/Shift+click): delete, duplicate, copy, group act on all of them. */
  selectedIds: string[];
  /** Every edit as a typed operation, newest last (history panel, audit, AI diffs). */
  opLog: LoggedOperation[];
  /** Set (to a timestamp) when an insert was refused for going over MAX_NODES blocks. */
  limitHit: number | null;
  hoverId: string | null;
  breakpoint: Breakpoint;
  /** Canvas zoom (1 = 100 %). */
  zoom: number;
  /**
   * "simple": a clean page of blocks — add from the library between blocks, edit texts in place,
   * open Content/Settings per block. "pro": palette, layers and the inspector always visible.
   */
  mode: EditorMode;
  /** The inspector drawer in simple mode, and which tab to show (counter: re-open the same tab). */
  inspector: { open: boolean; panel: InspectorPanel; n: number };
  /** The block library, inserting at this index of the page's top level. */
  library: { index: number } | null;
  /** Set while a collaboration session owns undo/redo (Y.UndoManager: only your own edits). */
  collabHistory: CollabHistory | null;
  /** Blocks collaborators have selected (drawn as coloured outlines on the canvas). */
  remoteSelections: RemoteSelection[];
  /** Board: where your pointer is on an artboard (shared with collaborators), and theirs. */
  localCursor: BoardCursor | null;
  remoteCursors: RemoteCursor[];
  /** Board: snap moves/resizes to the 8 px grid and to other elements; show the layout grid. */
  snap: boolean;
  grid: boolean;
  /** Board: bring a block into view (a layer was clicked, a search hit…); the counter re-triggers. */
  focus: { id: string; n: number } | null;

  /** Applies one typed operation; every other edit method goes through here. False = no change. */
  apply: (op: EditorOperation, coalesceKey?: string | null) => boolean;
  /**
   * Applies several operations as one edit (one undo step, each logged), e.g. an approved AI plan.
   * Operations that no longer fit the page (it changed meanwhile) are skipped and counted.
   */
  applyMany: (ops: EditorOperation[]) => { applied: number; skipped: number };
  setMeta: (patch: Partial<Omit<Draft, 'content'>>, coalesceKey?: string) => void;
  updateProps: (id: string, patch: Record<string, unknown>, coalesceKey?: string) => void;
  /** Name, visibility, lock and styles; style edits coalesce per property like typing. */
  updateNode: (id: string, patch: NodeMeta, coalesceKey?: string) => void;
  insert: (block: BlockNode, at?: { parentId: string; index: number }) => void;
  move: (id: string, parentId: string, index: number) => void;
  nudge: (id: string, delta: -1 | 1) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** Delete / duplicate / group / copy the whole selection. Copy, cut and paste return block counts. */
  removeSelection: () => void;
  duplicateSelection: () => void;
  /** False when the blocks can't share a group (different parents, or sections). */
  group: () => boolean;
  ungroup: (id: string) => void;
  copy: () => number;
  cut: () => number;
  paste: () => number;
  replace: (id: string, block: BlockNode) => void;
  setContent: (content: PageContent) => void;
  /** Server-side changes (restore, reload) that must not be undoable into. */
  reset: (draft: Draft) => void;
  markSaved: (draft: Draft) => void;
  /** A collaborator's change: replaces the draft without an undo step of its own. */
  applyRemote: (draft: Draft) => void;
  setCollabHistory: (h: CollabHistory | null) => void;
  setRemoteSelections: (r: RemoteSelection[]) => void;
  setLocalCursor: (c: BoardCursor | null) => void;
  setRemoteCursors: (c: RemoteCursor[]) => void;
  setSnap: (on: boolean) => void;
  setGrid: (on: boolean) => void;
  requestFocus: (id: string) => void;
  select: (id: string | null) => void;
  /** Adds or removes a block from the selection (Ctrl/Shift+click). */
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  /** Replaces the selection (marquee); the last id is the primary one. */
  selectMany: (ids: string[]) => void;
  hover: (id: string | null) => void;
  setBreakpoint: (b: Breakpoint) => void;
  setZoom: (z: number) => void;
  setMode: (m: EditorMode) => void;
  openInspector: (panel: InspectorPanel) => void;
  closeInspector: () => void;
  openLibrary: (index: number) => void;
  closeLibrary: () => void;
}

/**
 * "board": the infinite canvas — device artboards side by side on a board you pan and zoom, with
 * the library, layers and inspector around it. Same page, same blocks; only the workspace differs.
 */
export type EditorMode = 'simple' | 'pro' | 'board';

/** A pointer on an artboard: the breakpoint it edits and CSS px inside the page at that width. */
export interface BoardCursor {
  bp: StyleBreakpoint;
  x: number;
  y: number;
}
export interface RemoteCursor extends BoardCursor {
  clientId: number;
  name: string;
  color: string;
}
export type InspectorPanel = 'block' | 'style' | 'ai';
const MODE_KEY = 'canon.builder.mode';
function initialMode(): EditorMode {
  try {
    const m = window.localStorage.getItem(MODE_KEY);
    // New editors start on the board; a mode chosen before is kept.
    return m === 'pro' || m === 'simple' ? m : 'board';
  } catch {
    return 'board';
  }
}

export interface LoggedOperation {
  op: EditorOperation['op'];
  label: string;
  at: number;
}

const LOG_LIMIT = 200;

const countNodes = (n: BlockNode): number => n.children.reduce((a, c) => a + countNodes(c), 1);
/** Copied blocks live in localStorage, so copy on one page and paste on another works. */
const CLIPBOARD_KEY = 'canon.builder.clipboard';
let memoryClipboard: BlockNode[] = [];

function readClipboard(): BlockNode[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CLIPBOARD_KEY) ?? 'null') as { v?: number; nodes?: BlockNode[] } | null;
    if (raw?.v === 1 && Array.isArray(raw.nodes)) return raw.nodes;
  } catch {
    // Storage blocked: fall back to this tab's copy.
  }
  return memoryClipboard;
}

function writeClipboard(nodes: BlockNode[]): void {
  memoryClipboard = nodes;
  try {
    window.localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ v: 1, nodes }));
  } catch {
    // Storage blocked or full: the copy lasts for this tab only.
  }
}

export interface RemoteSelection {
  blockId: string;
  name: string;
  color: string;
}

export interface CollabHistory {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

/** Consecutive edits of the same field within this window collapse into one undo step (typing). */
const COALESCE_MS = 1_000;

export function createBuilderStore(initial: Draft) {
  let pendingKey: string | null = null;
  let lastKey: string | null = null;
  let lastAt = 0;

  const store = createStore<BuilderState>()(
    temporal(
      (set, get) => {
        const commit = (content: PageContent, key: string | null, extra: Partial<BuilderState> = {}) => {
          pendingKey = key;
          set({ draft: { ...get().draft, content }, ...extra });
        };
        const apply = (op: EditorOperation, key: string | null = null): boolean => {
          const d = get().draft;
          const content = applyOperation(d.content, op);
          if (content === d.content) return false;
          // The server refuses pages over MAX_NODES; growing past it here would only fail on save.
          if ((op.op === 'NODE_INSERT' || op.op === 'NODE_DUPLICATE') && countNodes(content.root) > MAX_NODES) {
            set({ limitHit: Date.now() });
            return false;
          }
          const entry: LoggedOperation = { op: op.op, label: describeOperation(op, d.content.root), at: Date.now() };
          const log = get().opLog;
          // Typing in one field is one logged edit, like it is one undo step.
          const same = Boolean(key) && key === lastKey && entry.at - lastAt < COALESCE_MS && log.at(-1)?.op === op.op;
          // One set: subscribers (the collaboration bridge) see the edit and its log entry together.
          commit(content, key, { opLog: same ? [...log.slice(0, -1), entry] : [...log, entry].slice(-LOG_LIMIT) });
          return true;
        };
        const selection = () => normalizeSelection(get().draft.content.root, get().selectedIds);
        const setSelection = (ids: string[]) => set({ selectedIds: ids, selectedId: ids.at(-1) ?? null });
        /**
         * Inserts copies right after the selection, like design tools paste; when its parent can't
         * hold them, falls back to the palette's rule (into the selection, or up the tree).
         */
        const insertCopies = (nodes: BlockNode[]) => {
          if (!nodes.length) return 0;
          const copies = nodes.map(cloneWithIds);
          const root = get().draft.content.root;
          const sel = get().selectedId;
          const near = sel ? findParent(root, sel) : null;
          const fits = near && copies.every((c) => canContain(near.parent, c.type, near.parent.id === root.id));
          const at = fits ? { parentId: near.parent.id, index: near.index + 1 } : insertionPoint(get().draft.content, sel, copies[0]!.type);
          if (!apply({ op: 'NODE_INSERT', parentId: at.parentId, index: at.index, nodes: copies })) return 0;
          setSelection(copies.map((c) => c.id));
          return copies.length;
        };
        return {
          draft: initial,
          saved: initial,
          selectedId: initial.content.root.children[0]?.id ?? null,
          selectedIds: initial.content.root.children[0] ? [initial.content.root.children[0].id] : [],
          opLog: [],
          limitHit: null,
          hoverId: null,
          breakpoint: 'base',
          zoom: 1,
          mode: typeof window === 'undefined' ? 'board' : initialMode(),
          localCursor: null,
          remoteCursors: [],
          snap: true,
          grid: false,
          focus: null,
          inspector: { open: false, panel: 'block', n: 0 },
          library: null,
          collabHistory: null,
          remoteSelections: [],

          setMeta: (patch, key) => {
            pendingKey = key ?? null;
            set({ draft: { ...get().draft, ...patch } });
          },
          apply,
          applyMany: (ops) => {
            const d = get().draft;
            let content = d.content;
            const entries: LoggedOperation[] = [];
            let skipped = 0;
            for (const op of ops) {
              const next = applyOperation(content, op);
              if (next === content || ((op.op === 'NODE_INSERT' || op.op === 'NODE_DUPLICATE') && countNodes(next.root) > MAX_NODES)) {
                skipped += 1;
                continue;
              }
              entries.push({ op: op.op, label: describeOperation(op, content.root), at: Date.now() });
              content = next;
            }
            if (entries.length) commit(content, null, { opLog: [...get().opLog, ...entries].slice(-LOG_LIMIT) });
            return { applied: entries.length, skipped };
          },
          updateProps: (id, patch, key) => void apply({ op: 'PROPS_UPDATE', id, patch }, key ?? null),
          updateNode: (id, patch, key) => void apply({ op: 'NODE_META', id, patch }, key ?? null),
          insert: (block, at) => {
            const to = at ?? insertionPoint(get().draft.content, get().selectedId, block.type);
            if (apply({ op: 'NODE_INSERT', parentId: to.parentId, index: to.index, nodes: [block] })) setSelection([block.id]);
          },
          // Locked blocks stay where they are until unlocked (applyOperation refuses).
          move: (id, parentId, index) => void apply({ op: 'NODE_MOVE', id, parentId, index }),
          nudge: (id, delta) => void apply({ op: 'NODE_REORDER', id, delta }),
          remove: (id) => {
            const root = get().draft.content.root;
            const at = findParent(root, id);
            if (!apply({ op: 'NODE_REMOVE', ids: [id] })) return;
            // Keep a sensible selection: next sibling, previous sibling, else the parent.
            const next = at ? (at.parent.children[at.index + 1] ?? at.parent.children[at.index - 1] ?? at.parent) : null;
            setSelection(next && next.id !== root.id ? [next.id] : []);
            set({ hoverId: null });
          },
          duplicate: (id) => {
            if (!apply({ op: 'NODE_DUPLICATE', id })) return;
            const at = findParent(get().draft.content.root, id);
            const copy = at?.parent.children[at.index + 1];
            if (copy) setSelection([copy.id]);
          },
          removeSelection: () => {
            const ids = selection();
            if (ids.length <= 1) return ids[0] ? get().remove(ids[0]) : undefined;
            // Locked blocks in the selection stay; the rest go.
            const root = get().draft.content.root;
            const free = ids.filter((id) => !findNode(root, id)?.locked);
            if (free.length && apply({ op: 'NODE_REMOVE', ids: free })) setSelection([]);
          },
          duplicateSelection: () => {
            const ids = selection();
            if (ids.length <= 1) return ids[0] ? get().duplicate(ids[0]) : undefined;
            const root = get().draft.content.root;
            insertCopies(ids.map((id) => findNode(root, id)!));
          },
          group: () => {
            const ids = selection();
            if (!ids.length) return false;
            const wrapper = newBlock('group');
            if (!apply({ op: 'NODE_GROUP', ids, wrapper })) return false;
            setSelection([wrapper.id]);
            return true;
          },
          ungroup: (id) => {
            const node = findNode(get().draft.content.root, id);
            if (node && apply({ op: 'NODE_UNGROUP', id })) setSelection(node.children.map((c) => c.id));
          },
          copy: () => {
            const root = get().draft.content.root;
            const nodes = selection().map((id) => findNode(root, id)!);
            if (nodes.length) writeClipboard(nodes);
            return nodes.length;
          },
          cut: () => {
            const n = get().copy();
            if (n) get().removeSelection();
            return n;
          },
          paste: () => insertCopies(readClipboard()),
          replace: (id, block) => void apply({ op: 'NODE_REPLACE', id, node: block }),
          setContent: (content) => {
            commit(content, null);
            setSelection(content.root.children[0] ? [content.root.children[0].id] : []);
          },
          reset: (draft) => {
            set({ draft, saved: draft });
            store.temporal.getState().clear();
          },
          markSaved: (draft) => set({ saved: draft }),
          applyRemote: (draft) => {
            const t = store.temporal.getState();
            t.pause();
            const sel = get().selectedId;
            // A collaborator may delete the block you have selected.
            const keep = get().selectedIds.filter((id) => findNode(draft.content.root, id));
            set({ draft, selectedIds: keep, selectedId: sel && keep.includes(sel) ? sel : (keep.at(-1) ?? null) });
            t.resume();
          },
          setCollabHistory: (collabHistory) => set({ collabHistory }),
          setRemoteSelections: (remoteSelections) => set({ remoteSelections }),
          setLocalCursor: (localCursor) => set({ localCursor }),
          setRemoteCursors: (remoteCursors) => set({ remoteCursors }),
          setSnap: (snap) => set({ snap }),
          setGrid: (grid) => set({ grid }),
          requestFocus: (id) => set({ focus: { id, n: (get().focus?.n ?? 0) + 1 } }),
          select: (id) => setSelection(id ? [id] : []),
          toggleSelect: (id) => {
            const cur = get().selectedIds;
            setSelection(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
          },
          selectMany: (ids) => setSelection(ids.filter((id) => findNode(get().draft.content.root, id))),
          selectAll: () => setSelection(get().draft.content.root.children.map((c) => c.id)),
          hover: (id) => (get().hoverId === id ? undefined : set({ hoverId: id })),
          setBreakpoint: (breakpoint) => set({ breakpoint }),
          setZoom: (zoom) => set({ zoom: Math.min(2, Math.max(0.25, zoom)) }),
          setMode: (mode) => {
            try {
              window.localStorage.setItem(MODE_KEY, mode);
            } catch {
              // Not remembered: the next visit starts in simple mode.
            }
            set({ mode });
          },
          openInspector: (panel) => set({ inspector: { open: true, panel, n: get().inspector.n + 1 } }),
          closeInspector: () => set({ inspector: { ...get().inspector, open: false } }),
          openLibrary: (index) => set({ library: { index } }),
          closeLibrary: () => set({ library: null }),
        };
      },
      {
        partialize: (s) => ({ draft: s.draft }),
        equality: (a, b) => a.draft === b.draft,
        limit: 200,
        // zundo types handleSet like setState, but calls it with (past, replace, current, delta).
        handleSet: (handleSet) => (past, replace, current, delta) => {
          const record = handleSet as unknown as (...args: unknown[]) => void;
          // Selection/hover sets don't touch the draft: let zundo's equality skip them untouched.
          if ((past as { draft?: Draft }).draft === store.getState().draft) return record(past, replace, current, delta);
          const now = Date.now();
          const key = pendingKey;
          pendingKey = null;
          if (key && key === lastKey && now - lastAt < COALESCE_MS) {
            lastAt = now;
            return;
          }
          lastKey = key;
          lastAt = now;
          record(past, replace, current, delta);
        },
      },
    ),
  );
  return store;
}

export type BuilderStore = ReturnType<typeof createBuilderStore>;

export const BuilderContext = createContext<BuilderStore | null>(null);

export function useBuilder<T>(selector: (s: BuilderState) => T): T {
  const s = useContext(BuilderContext);
  if (!s) throw new Error('useBuilder outside <BuilderContext>');
  return useStore(s, selector);
}

export function useBuilderStore(): BuilderStore {
  const s = useContext(BuilderContext);
  if (!s) throw new Error('useBuilderStore outside <BuilderContext>');
  return s;
}

export function useHistory() {
  const s = useBuilderStore();
  const t = s.temporal as StoreApi<ReturnType<BuilderStore['temporal']['getState']>>;
  const canUndo = useStore(t, (x) => x.pastStates.length > 0);
  const canRedo = useStore(t, (x) => x.futureStates.length > 0);
  const collab = useStore(s, (x) => x.collabHistory);
  if (collab) return collab;
  return { canUndo, canRedo, undo: () => t.getState().undo(), redo: () => t.getState().redo() };
}

/** Undo/redo outside React (shortcuts): the collaboration history wins while a session is live. */
export function historyOf(s: BuilderStore): { undo: () => void; redo: () => void } {
  return s.getState().collabHistory ?? s.temporal.getState();
}

export function selectedNode(s: BuilderState): BlockNode | null {
  return s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null;
}

export { cloneWithIds };
