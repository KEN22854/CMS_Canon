'use client';

import { LOCAL, Y, applyDraftDiff, draftHash, draftToYDoc, isInitialized, yDocToDraft, type CollabDraft, type SavedMarker } from '@canon/collab';
import { useEffect, useMemo, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import { useAuth } from '@/lib/auth-store';
import type { BuilderStore, Draft } from './store';

export interface Peer {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  canEdit: boolean;
  selectedId: string | null;
}

export interface CollabState {
  status: 'connecting' | 'connected' | 'offline';
  peers: Peer[];
  /** This tab writes autosaves for the room (solo or lowest client id among editors). */
  isLeader: boolean;
  leaderName: string | null;
  /** Tell the room a save landed, so every peer marks the same draft saved at `version`. */
  announceSaved: (version: number, saved: Draft) => void;
  /** Push a draft (e.g. the latest server version after a conflict) to everyone. */
  replaceAll: (draft: Draft) => void;
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4f46e5'];
const colorFor = (id: string) => COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;

/** The draft shapes are the same tree; the builder's types are just stricter. */
const asCollab = (d: Draft) => d as unknown as CollabDraft;
const asDraft = (d: CollabDraft) => d as unknown as Draft;

function collabUrl(): string {
  const env = process.env.NEXT_PUBLIC_CANON_COLLAB_URL;
  if (env) return env;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/v1/collab`;
}

/**
 * Binds the builder store to the page's collaboration room.
 *
 * Local edits become minimal Yjs diffs; remote ones replace the draft without polluting undo.
 * While connected, undo/redo is a Y.UndoManager scoped to *your* edits, so undoing never reverts
 * a collaborator's work. Exactly one tab (the leader) autosaves through the normal CAS endpoint and
 * then writes a `saved` marker; the others adopt its version and mark the same draft clean.
 * If the room is unreachable the builder silently stays in single-user mode.
 */
export function useCollab({ store, pageId, canEdit, onVersion }: { store: BuilderStore; pageId: string; canEdit: boolean; onVersion: (v: number) => void }): CollabState {
  const user = useAuth((s) => s.user);
  const [status, setStatus] = useState<CollabState['status']>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [selfId, setSelfId] = useState<number | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const onVersionRef = useRef(onVersion);
  onVersionRef.current = onVersion;

  useEffect(() => {
    const token = useAuth.getState().accessToken;
    if (!token || !user) return;
    const doc = new Y.Doc();
    docRef.current = doc;
    setSelfId(doc.clientID);
    const provider = new WebsocketProvider(collabUrl(), `page:${pageId}`, doc, { params: { token }, disableBc: true, maxBackoffTime: 10_000 });
    const meta = doc.getMap('meta');
    let synced = false;
    let mirrored: Draft | null = null; // the draft the store and the doc last agreed on
    let failures = 0;

    // Access tokens are short-lived; reconnects read params afresh.
    const unsubAuth = useAuth.subscribe((s) => s.accessToken && (provider.params = { token: s.accessToken }));

    const pull = () => {
      const next = yDocToDraft(doc);
      if (!next) return;
      mirrored = asDraft(next);
      store.getState().applyRemote(mirrored);
      checkSaved();
    };
    const checkSaved = () => {
      const marker = meta.get('saved') as SavedMarker | undefined;
      const s = store.getState();
      if (!marker) return;
      onVersionRef.current(marker.version);
      if (marker.hash === draftHash(asCollab(s.draft))) s.markSaved(s.draft);
    };

    const undo = new Y.UndoManager([meta, doc.getMap('blocks')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 800 });
    const publishHistory = () =>
      store.getState().setCollabHistory({
        canUndo: undo.undoStack.length > 0,
        canRedo: undo.redoStack.length > 0,
        undo: () => undo.undo(),
        redo: () => undo.redo(),
      });

    provider.on('status', ({ status: st }: { status: string }) => {
      if (st === 'connected') (failures = 0), setStatus('connected');
      else if (st === 'disconnected') setStatus(synced ? 'offline' : 'connecting');
    });
    provider.on('connection-close', () => {
      // Rejected upgrades (no access, server without collab) close before syncing: give up quietly.
      if (!synced && ++failures >= 3) {
        provider.disconnect();
        setStatus('offline');
      }
    });
    provider.on('sync', (isSynced: boolean) => {
      if (!isSynced || synced) return;
      synced = true;
      const s = store.getState();
      if (canEdit) {
        if (!isInitialized(doc)) draftToYDoc(doc, asCollab(s.saved));
        // Edits made before the first sync ride on top of the room's state as a diff.
        if (s.draft !== s.saved) applyDraftDiff(doc, asCollab(s.saved), asCollab(s.draft));
      }
      pull();
      undo.clear();
      publishHistory();
    });

    doc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (!synced) return;
      if (origin === 'saved') checkSaved();
      else if (origin !== LOCAL) pull();
      publishHistory();
    });

    const unsubStore = store.subscribe((s, prev) => {
      if (!synced || !canEdit || s.draft === prev.draft || s.draft === mirrored || !mirrored) return;
      const before = mirrored;
      mirrored = s.draft;
      applyDraftDiff(doc, asCollab(before), asCollab(s.draft));
    });
    const unsubSel = store.subscribe((s, prev) => s.selectedId !== prev.selectedId && provider.awareness.setLocalStateField('selectedId', s.selectedId));

    provider.awareness.setLocalState({ user: { id: user.id, name: user.name || user.email, color: colorFor(user.id), canEdit }, selectedId: store.getState().selectedId });
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((st, clientId) => {
        const u = st.user as { id: string; name: string; color: string; canEdit: boolean } | undefined;
        if (u) list.push({ clientId, userId: u.id, name: u.name, color: u.color, canEdit: u.canEdit, selectedId: (st.selectedId as string | null) ?? null });
      });
      setPeers(list.sort((a, b) => a.clientId - b.clientId));
      store.getState().setRemoteSelections(list.filter((p) => p.clientId !== doc.clientID && p.selectedId).map((p) => ({ blockId: p.selectedId!, name: p.name, color: p.color })));
    };
    provider.awareness.on('change', onAwareness);
    onAwareness();

    return () => {
      unsubAuth();
      unsubStore();
      unsubSel();
      store.getState().setCollabHistory(null);
      store.getState().setRemoteSelections([]);
      undo.destroy();
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      doc.destroy();
      docRef.current = null;
    };
    // `user` identity is stable for the session; reconnect only for another page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, pageId, canEdit, user?.id]);

  return useMemo(() => {
    const editors = peers.filter((p) => p.canEdit);
    const live = status === 'connected';
    const leader = live ? editors[0] : undefined;
    return {
      status,
      peers,
      isLeader: !live || !leader || leader.clientId === selfId,
      leaderName: leader && leader.clientId !== selfId ? leader.name : null,
      announceSaved: (version, saved) => {
        const doc = docRef.current;
        if (!doc || !live) return;
        const marker: SavedMarker = { version, hash: draftHash(asCollab(saved)), by: user?.name ?? '' };
        doc.transact(() => doc.getMap('meta').set('saved', marker), 'saved');
      },
      replaceAll: (draft) => {
        const doc = docRef.current;
        const current = doc && yDocToDraft(doc);
        if (!doc || !current) return;
        applyDraftDiff(doc, current, asCollab(draft), 'replace');
      },
    };
  }, [status, peers, selfId, user?.name]);
}
