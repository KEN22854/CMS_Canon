'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { REVIEW_BADGE, type Review, type ReviewStatus } from '@/components/review-panel';
import { Alert, Badge, Card, CardContent } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';

type Filter = 'mine' | ReviewStatus | 'all';

const FILTERS: [Filter, MessageKey][] = [
  ['mine', 'review.queue.mine'],
  ['OPEN', 'review.queue.open'],
  ['CHANGES_REQUESTED', 'review.queue.changes'],
  ['APPROVED', 'review.queue.approved'],
  ['all', 'review.queue.all'],
];

/** The site's review queue: what is waiting for a decision, and what came back. */
export default function ReviewsPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const tid = useTenantId();
  const [filter, setFilter] = useState<Filter>('mine');
  const t = useT();
  const qs = filter === 'mine' ? 'status=OPEN&mine=true' : filter === 'all' ? '' : `status=${filter}`;
  const list = useQuery({
    queryKey: ['reviews', tid, siteId, 'queue', filter],
    queryFn: () => api<Review[]>(`/sites/${siteId}/reviews?${qs}`),
    enabled: Boolean(tid),
  });
  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap gap-1 rounded-md border p-0.5 text-sm"
        role="radiogroup"
        aria-label={t('notif.show')}
      >
        {FILTERS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={filter === v}
            onClick={() => setFilter(v)}
            className={cn(
              'rounded px-2.5 py-1',
              filter === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <div className="grid gap-2">
        {list.data?.map((r) => (
          <Link key={r.id} href={`${r.link}?review=${r.id}`}>
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.title}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      {t(r.entityType === 'PAGE' ? 'review.queue.page' : 'review.queue.entry')} · v{r.version}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.requestedByName ?? t('review.someone')} · {relativeTime(r.createdAt)}
                    {r.note && <> · “{r.note.length > 90 ? `${r.note.slice(0, 87)}…` : r.note}”</>}
                  </p>
                </div>
                {r.stale && r.status !== 'CANCELLED' && (
                  <Badge className="border-warning/40 text-warning">{t('review.queue.editedSince')}</Badge>
                )}
                <Badge className={REVIEW_BADGE[r.status].className}>{t(REVIEW_BADGE[r.status].label)}</Badge>
              </CardContent>
            </Card>
          </Link>
        ))}
        {list.data?.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {filter === 'mine' ? t('review.queue.nothingMine') : t('review.queue.none')}
          </p>
        )}
      </div>
    </div>
  );
}
