import type { BlockNode, PageContent } from '@canon/blocks';
import { useStore } from 'zustand';
import { temporal } from 'zundo';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createContext, useContext } from 'react';
import type { PageDetail } from '@/lib/content';
import { cloneWithIds, duplicateBlock, findNode, findParent, insertBlock, insertNear, moveBlock, moveTo, removeBlock, replaceBlock, updateProps } from '../editor/tree-ops';

export interface Draft {
  title: string;
  slug: string;
  description: string;
  seo: PageDetail['seo'];
  content: PageContent;
}

export type Breakpoint = 'desktop' | 'tablet' | 'mobile';

export interface BuilderState {
  /** The only undoable slice. Every edit replaces it immutably, so "dirty" is a reference check. */
  draft: Draft;
  /** The draft object last acknowledged by the server. */
  saved: Draft;
  selectedId: string | null;
  hoverId: string | null;
  breakpoint: Breakpoint;

  setMeta: (patch: Partial<Omit<Draft, 'content'>>, coalesceKey?: string) => void;
  updateProps: (id: string, patch: Record<string, unknown>, coalesceKey?: string) => void;
  insert: (block: BlockNode, at?: { parentId: string; index: number }) => void;
  move: (id: string, parentId: string, index: number) => void;
  nudge: (id: string, delta: -1 | 1) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  replace: (id: string, block: BlockNode) => void;
  setContent: (content: PageContent) => void;
  /** Server-side changes (restore, reload) that must not be undoable into. */
  reset: (draft: Draft) => void;
  markSaved: (draft: Draft) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  setBreakpoint: (b: Breakpoint) => void;
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
        const edit = (fn: (c: PageContent) => PageContent, key: string | null = null) => {
          const d = get().draft;
          const content = fn(d.content);
          if (content === d.content) return;
          pendingKey = key;
          set({ draft: { ...d, content } });
        };
        return {
          draft: initial,
          saved: initial,
          selectedId: initial.content.root.children[0]?.id ?? null,
          hoverId: null,
          breakpoint: 'desktop',

          setMeta: (patch, key) => {
            pendingKey = key ?? null;
            set({ draft: { ...get().draft, ...patch } });
          },
          updateProps: (id, patch, key) => edit((c) => updateProps(c, id, patch), key ?? null),
          insert: (block, at) => {
            edit((c) => (at ? insertBlock(c, at.parentId, at.index, block) : insertNear(c, get().selectedId, block)));
            set({ selectedId: block.id });
          },
          move: (id, parentId, index) => edit((c) => moveTo(c, id, parentId, index)),
          nudge: (id, delta) => edit((c) => moveBlock(c, id, delta)),
          remove: (id) => {
            const root = get().draft.content.root;
            if (id === root.id) return;
            const at = findParent(root, id);
            edit((c) => removeBlock(c, id));
            // Keep a sensible selection: next sibling, previous sibling, else the parent.
            const next = at ? (at.parent.children[at.index + 1] ?? at.parent.children[at.index - 1] ?? at.parent) : null;
            set({ selectedId: next && next.id !== root.id ? next.id : null, hoverId: null });
          },
          duplicate: (id) => {
            const before = get().draft.content;
            edit((c) => duplicateBlock(c, id));
            const at = findParent(get().draft.content.root, id);
            const copy = at?.parent.children[at.index + 1];
            if (copy && get().draft.content !== before) set({ selectedId: copy.id });
          },
          replace: (id, block) => edit((c) => replaceBlock(c, id, block)),
          setContent: (content) => {
            pendingKey = null;
            set({ draft: { ...get().draft, content }, selectedId: content.root.children[0]?.id ?? null });
          },
          reset: (draft) => {
            set({ draft, saved: draft });
            store.temporal.getState().clear();
          },
          markSaved: (draft) => set({ saved: draft }),
          select: (id) => set({ selectedId: id }),
          hover: (id) => (get().hoverId === id ? undefined : set({ hoverId: id })),
          setBreakpoint: (breakpoint) => set({ breakpoint }),
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
  return { canUndo, canRedo, undo: () => t.getState().undo(), redo: () => t.getState().redo() };
}

export function selectedNode(s: BuilderState): BlockNode | null {
  return s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null;
}

export { cloneWithIds };
