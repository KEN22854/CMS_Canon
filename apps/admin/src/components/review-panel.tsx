'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  Check,
  CheckCircle2,
  CircleDot,
  MessageSquare,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { useMembers, useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';
import { Alert, Badge, Button, Select } from './ui';

export type ReviewStatus = 'OPEN' | 'APPROVED' | 'CHANGES_REQUESTED' | 'CANCELLED';

export interface Review {
  id: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  title: string;
  link: string;
  version: number;
  currentVersion: number;
  stale: boolean;
  status: ReviewStatus;
  note: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  reviewerIds: string[];
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

interface CommentRow {
  id: string;
  blockId: string | null;
  parentId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  mentions: string[];
  resolvedAt: string | null;
  createdAt: string;
}

export const REVIEW_BADGE: Record<ReviewStatus, { label: MessageKey; className: string }> = {
  OPEN: { label: 'review.status.OPEN', className: 'border-primary/40 text-primary' },
  APPROVED: {
    label: 'review.status.APPROVED',
    className: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  },
  CHANGES_REQUESTED: {
    label: 'review.status.CHANGES_REQUESTED',
    className: 'border-warning/40 text-warning',
  },
  CANCELLED: { label: 'review.status.CANCELLED', className: 'text-muted-foreground' },
};

interface Props {
  siteId: string;
  entityType: 'PAGE' | 'ENTRY';
  entityId: string;
  /** Saves pending edits so the review covers what the requester sees. */
  beforeRequest?: () => Promise<boolean>;
  /** The block currently selected in the builder: new comments anchor to it. */
  blockId?: string | null;
  blockLabel?: (id: string) => string | undefined;
  onSelectBlock?: (id: string) => void;
}

/** Review status and actions, then comment threads (anchored to blocks when there is a canvas). */
export function ReviewPanel(props: Props) {
  return (
    <div className="space-y-6">
      <ReviewBox {...props} />
      <Comments {...props} />
    </div>
  );
}

function ReviewBox({ siteId, entityType, entityId, beforeRequest }: Props) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user?.id);
  const ability = useAbility();
  const members = useMembers();
  const key = ['reviews', tid, siteId, entityId];
  const reviews = useQuery({
    queryKey: key,
    queryFn: () => api<Review[]>(`/sites/${siteId}/reviews?entityId=${entityId}`),
    enabled: Boolean(tid),
  });
  const [note, setNote] = useState('');
  const [reviewer, setReviewer] = useState('');
  const t = useT();
  const refresh = () => {
    setNote('');
    void qc.invalidateQueries({ queryKey: ['reviews', tid, siteId] });
  };
  const ask = useMutation({
    mutationFn: async () => {
      if (beforeRequest && !(await beforeRequest())) throw new Error(t('review.saveFailed'));
      return api<Review>(`/sites/${siteId}/reviews`, {
        body: { entityType, entityId, note: note || undefined, reviewerIds: reviewer ? [reviewer] : [] },
      });
    },
    onSuccess: () => (refresh(), toast.success(t('review.requested'))),
    onError: (err) => toast.error(err instanceof Error ? err.message : errorMessage(err)),
  });
  const decide = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'approve' | 'request-changes' | 'cancel' }) =>
      api<Review>(`/reviews/${id}/${op}`, { body: op === 'cancel' ? {} : { note: note || undefined } }),
    onSuccess: (r) => (refresh(), toast.success(t(REVIEW_BADGE[r.status].label))),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const latest = reviews.data?.[0];
  const open = latest?.status === 'OPEN' ? latest : null;
  const canReview = ability.can('publish', entityType === 'PAGE' ? 'Page' : 'Entry');
  const publishers = (members.data ?? []).filter(
    (m) => ['OWNER', 'ADMIN', 'EDITOR'].includes(m.role) && m.id !== me,
  );

  return (
    <section className="space-y-3" aria-label={t('review.title')}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t('review.title')}</p>
        {latest && (
          <Badge className={REVIEW_BADGE[latest.status].className}>
            {t(REVIEW_BADGE[latest.status].label)}
          </Badge>
        )}
      </div>
      {latest && latest.status !== 'CANCELLED' && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
          <p>
            {t('review.asked', {
              who: latest.requestedByName ?? t('review.someone'),
              version: latest.version,
              when: relativeTime(latest.createdAt),
            })}
          </p>
          {latest.note && <p className="whitespace-pre-wrap text-muted-foreground">“{latest.note}”</p>}
          {latest.decidedByName && latest.status !== 'OPEN' && (
            <p>
              {t(latest.status === 'APPROVED' ? 'review.approvedBy' : 'review.changesBy', {
                who: latest.decidedByName,
                when: latest.decidedAt ? relativeTime(latest.decidedAt) : '',
              })}
              {latest.decisionNote && (
                <span className="block whitespace-pre-wrap text-muted-foreground">
                  “{latest.decisionNote}”
                </span>
              )}
            </p>
          )}
          {latest.stale && latest.status !== 'CHANGES_REQUESTED' && (
            <p className="text-warning">{t('review.stale', { version: latest.currentVersion })}</p>
          )}
        </div>
      )}
      <textarea
        aria-label={
          open && canReview && open.requestedById !== me ? t('review.feedback') : t('review.noteForReviewer')
        }
        rows={2}
        value={note}
        placeholder={
          open && canReview && open.requestedById !== me ? t('review.feedback') : t('review.noteForReviewer')
        }
        onChange={(e) => setNote(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      {open && canReview && open.requestedById !== me ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            loading={decide.isPending && decide.variables?.op === 'approve'}
            onClick={() => decide.mutate({ id: open.id, op: 'approve' })}
          >
            <Check className="h-4 w-4" /> {t('review.approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={!note.trim()}
            loading={decide.isPending && decide.variables?.op === 'request-changes'}
            onClick={() => decide.mutate({ id: open.id, op: 'request-changes' })}
          >
            <Undo2 className="h-4 w-4" /> {t('review.requestChanges')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Select
            aria-label={t('review.reviewer')}
            className="w-full"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          >
            <option value="">{t('review.anyPublisher')}</option>
            {publishers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.role.toLowerCase()})
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" loading={ask.isPending} onClick={() => ask.mutate()}>
              {open ? <RotateCcw className="h-4 w-4" /> : <CircleDot className="h-4 w-4" />}{' '}
              {open ? t('review.askAgain') : t('review.ask')}
            </Button>
            {open && open.requestedById === me && (
              <Button
                size="sm"
                variant="ghost"
                loading={decide.isPending && decide.variables?.op === 'cancel'}
                onClick={() => decide.mutate({ id: open.id, op: 'cancel' })}
              >
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Comments({ entityType, entityId, blockId, blockLabel, onSelectBlock }: Props) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const me = useAuth((s) => s.user?.id);
  const ability = useAbility();
  const members = useMembers();
  const key = ['comments', tid, entityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<CommentRow[]>(`/comments?entityType=${entityType}&entityId=${entityId}`),
    enabled: Boolean(tid),
  });
  const [onlyBlock, setOnlyBlock] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const t = useT();
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const post = useMutation({
    mutationFn: (b: { body: string; mentions: string[]; parentId?: string; blockId?: string }) =>
      api<CommentRow>('/comments', { body: { entityType, entityId, ...b } }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const patch = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api(`/comments/${id}`, { method: 'PATCH', body: { resolved } }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/comments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });

  const threads = useMemo(() => {
    const rows = list.data ?? [];
    return rows
      .filter((c) => !c.parentId)
      .map((root) => ({ root, replies: rows.filter((r) => r.parentId === root.id) }))
      .filter(
        (t) => (showResolved || !t.root.resolvedAt) && (!onlyBlock || !blockId || t.root.blockId === blockId),
      );
  }, [list.data, showResolved, onlyBlock, blockId]);
  const resolvedCount = (list.data ?? []).filter((c) => !c.parentId && c.resolvedAt).length;

  return (
    <section className="space-y-3 border-t pt-4" aria-label={t('review.comments')}>
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <MessageSquare className="h-4 w-4" aria-hidden /> {t('review.comments')}
        </p>
        <div className="flex gap-3 text-[11px] text-muted-foreground">
          {blockId && (
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={onlyBlock} onChange={(e) => setOnlyBlock(e.target.checked)} />{' '}
              {t('review.thisBlock')}
            </label>
          )}
          {resolvedCount > 0 && (
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />{' '}
              {t('review.resolved', { count: resolvedCount })}
            </label>
          )}
        </div>
      </div>
      <Composer
        members={members.data ?? []}
        me={me}
        placeholder={
          blockId && blockLabel?.(blockId)
            ? t('review.commentOn', { block: blockLabel(blockId)! })
            : t('review.writeComment')
        }
        pending={post.isPending}
        onSend={(body, mentions) => post.mutateAsync({ body, mentions, blockId: blockId ?? undefined })}
      />
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      {threads.map(({ root, replies }) => (
        <div
          key={root.id}
          id={`comment-${root.id}`}
          className={cn('space-y-2 rounded-md border p-3', root.resolvedAt && 'opacity-60')}
        >
          {root.blockId && (
            <button
              type="button"
              onClick={() => onSelectBlock?.(root.blockId!)}
              className="text-[11px] text-primary hover:underline"
            >
              {t('review.onBlock', { block: blockLabel?.(root.blockId) ?? t('review.removedBlock') })}
            </button>
          )}
          {[root, ...replies].map((c) => (
            <div key={c.id} className={cn('group text-sm', c.parentId && 'border-l-2 pl-2')}>
              <p className="text-xs">
                <span className="font-medium">{c.authorName ?? t('review.formerMember')}</span>{' '}
                <span className="text-muted-foreground">{relativeTime(c.createdAt)}</span>
              </p>
              <p className="whitespace-pre-wrap break-words">{c.body}</p>
              {(c.authorId === me || ability.can('manage', 'all')) && (
                <button
                  type="button"
                  aria-label={t('review.deleteComment')}
                  onClick={() =>
                    window.confirm(c.parentId ? t('review.deleteReply') : t('review.deleteThread')) &&
                    remove.mutate(c.id)
                  }
                  className="hidden text-muted-foreground hover:text-destructive group-hover:inline"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 pt-1">
            <ReplyBox
              members={members.data ?? []}
              me={me}
              onSend={(body, mentions) => post.mutateAsync({ body, mentions, parentId: root.id })}
            />
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => patch.mutate({ id: root.id, resolved: !root.resolvedAt })}
            >
              {root.resolvedAt ? <X className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}{' '}
              {root.resolvedAt ? t('review.reopen') : t('review.resolve')}
            </Button>
          </div>
        </div>
      ))}
      {!list.isPending && threads.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('review.noComments')}</p>
      )}
    </section>
  );
}

type MemberLite = { id: string; name: string };

/** Text box with an @mention picker; mentioned people are notified. */
function Composer({
  members,
  me,
  placeholder,
  pending,
  onSend,
  compact,
}: {
  members: MemberLite[];
  me?: string;
  placeholder: string;
  pending?: boolean;
  onSend: (body: string, mentions: string[]) => Promise<unknown>;
  compact?: boolean;
}) {
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const others = members.filter((m) => m.id !== me);
  const t = useT();
  const send = async () => {
    // Only people whose @Name is still in the text are notified.
    const kept = mentions.filter((id) =>
      body.includes(`@${others.find((m) => m.id === id)?.name ?? '\u0000'}`),
    );
    await onSend(body.trim(), kept);
    setBody('');
    setMentions([]);
  };
  return (
    <div className={cn('space-y-1.5', compact && 'flex-1')}>
      <textarea
        aria-label={placeholder}
        rows={compact ? 1 : 2}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && body.trim()) void send();
        }}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1 text-muted-foreground">
          <AtSign className="h-3.5 w-3.5" aria-hidden />
          <select
            aria-label={t('review.mentionLabel')}
            value=""
            onChange={(e) => {
              const m = others.find((x) => x.id === e.target.value);
              if (!m) return;
              setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.name} `);
              setMentions((ids) => [...new Set([...ids, m.id])]);
            }}
            className="bg-transparent text-xs"
          >
            <option value="">{t('review.mention')}</option>
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant={compact ? 'ghost' : 'default'}
          disabled={!body.trim()}
          loading={pending}
          onClick={() => void send()}
        >
          {compact ? t('review.reply') : t('review.comment')}
        </Button>
      </div>
    </div>
  );
}

function ReplyBox(props: {
  members: MemberLite[];
  me?: string;
  onSend: (body: string, mentions: string[]) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {t('review.reply')}
      </button>
    );
  return (
    <Composer
      {...props}
      compact
      placeholder={t('review.replyPlaceholder')}
      onSend={async (b, m) => (await props.onSend(b, m), setOpen(false))}
    />
  );
}
