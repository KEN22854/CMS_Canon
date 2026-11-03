'use client';

import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMarkRead, useNotifications, useUnreadCount, type AppNotification } from '@/lib/notifications';
import { useT } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';

/** Bell with the unread count; the dropdown shows the latest and links to the full inbox. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = useUnreadCount().data?.unread ?? 0;
  const t = useT();

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? t('notif.unreadLabel', { count: unread }) : t('notif.title')}
        className="relative rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && <Panel onClose={() => setOpen(false)} />}
    </div>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const list = useNotifications();
  const markRead = useMarkRead();
  const t = useT();
  const items = list.data?.items.slice(0, 8) ?? [];
  return (
    <div
      role="dialog"
      aria-label={t('notif.title')}
      className="absolute right-0 z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] md:left-0 md:right-auto rounded-md border bg-card shadow-lg"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <p className="text-sm font-medium">{t('notif.title')}</p>
        {(list.data?.unread ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => markRead.mutate('all')}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden /> {t('notif.markAllRead')}
          </button>
        )}
      </div>
      <ul className="max-h-96 overflow-y-auto">
        {items.map((n) => (
          <li key={n.id}>
            <NotificationItem n={n} compact onOpen={onClose} />
          </li>
        ))}
        {!list.isPending && items.length === 0 && (
          <li className="px-3 py-8 text-center text-sm text-muted-foreground">{t('notif.caughtUp')}</li>
        )}
      </ul>
      <Link
        href="/notifications"
        onClick={onClose}
        className="block border-t px-3 py-2 text-center text-xs text-primary hover:underline"
      >
        {t('notif.allAndSettings')}
      </Link>
    </div>
  );
}

export function NotificationItem({
  n,
  compact,
  onOpen,
}: {
  n: AppNotification;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const router = useRouter();
  const markRead = useMarkRead();
  const open = () => {
    if (!n.isRead) markRead.mutate([n.id]);
    onOpen?.();
    if (n.link) router.push(n.link);
  };
  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'flex w-full gap-2 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/60',
        compact ? 'text-xs' : 'text-sm',
      )}
    >
      <span
        className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : 'bg-primary')}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block', !n.isRead && 'font-medium')}>{n.title}</span>
        {n.message && (
          <span className={cn('block text-muted-foreground', compact && 'line-clamp-2')}>{n.message}</span>
        )}
        <span className="block text-[11px] text-muted-foreground">
          {relativeTime(n.createdAt)}
          {!n.isRead && <span className="sr-only"> · unread</span>}
        </span>
      </span>
    </button>
  );
}
