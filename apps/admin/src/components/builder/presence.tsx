'use client';

import { cn } from '@/lib/utils';
import type { CollabState } from './collab';

/** Avatars of everyone in the room (you first), with the connection state. */
export function Presence({ collab, selfId }: { collab: CollabState; selfId: string | undefined }) {
  if (collab.status === 'offline' && collab.peers.length <= 1) return null;
  const seen = new Set<string>();
  // One avatar per person, even with the page open in several tabs.
  const people = collab.peers.filter((p) => !seen.has(p.userId) && seen.add(p.userId));
  const others = people.filter((p) => p.userId !== selfId);
  return (
    <div className="flex items-center gap-2" aria-label="People editing this page">
      <span
        className={cn('h-2 w-2 rounded-full', collab.status === 'connected' ? 'bg-success' : collab.status === 'connecting' ? 'animate-pulse bg-warning' : 'bg-muted-foreground')}
        title={collab.status === 'connected' ? 'Live' : collab.status === 'connecting' ? 'Connecting…' : 'Offline — changes are kept locally'}
      />
      <div className="flex -space-x-1.5">
        {others.slice(0, 5).map((p) => (
          <span key={p.userId} title={`${p.name}${p.canEdit ? '' : ' (viewing)'}`} className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-background" style={{ background: p.color }}>
            {initials(p.name)}
          </span>
        ))}
        {others.length > 5 && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] ring-2 ring-background">+{others.length - 5}</span>}
      </div>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
