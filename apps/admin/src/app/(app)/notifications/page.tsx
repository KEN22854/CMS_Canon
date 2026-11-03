'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { NotificationItem } from '@/components/notification-bell';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import {
  useMarkRead,
  useNotificationPrefs,
  useNotifications,
  type EmailDelivery,
  type NotificationPref,
} from '@/lib/notifications';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const DELIVERY_LABEL: Record<EmailDelivery, MessageKey> = {
  instant: 'notif.instant',
  digest: 'notif.digest',
  off: 'notif.off',
};

export default function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useNotifications(unreadOnly);
  const markRead = useMarkRead();
  const t = useT();
  return (
    <>
      <PageHeader title={t('notif.title')} description={t('notif.description')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div
              className="flex gap-1 rounded-md border p-0.5 text-sm"
              role="radiogroup"
              aria-label={t('notif.show')}
            >
              {(
                [
                  [false, 'notif.all'],
                  [true, 'notif.unread'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={unreadOnly === v}
                  onClick={() => setUnreadOnly(v)}
                  className={cn(
                    'rounded px-2.5 py-1',
                    unreadOnly === v ? 'bg-muted font-medium' : 'text-muted-foreground',
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!list.data?.unread}
              loading={markRead.isPending}
              onClick={() => markRead.mutate('all')}
            >
              {t('notif.markAllRead')}
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
            {list.data?.items.map((n) => (
              <NotificationItem key={n.id} n={n} />
            ))}
            {list.data?.items.length === 0 && (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {unreadOnly ? t('notif.nothingUnread') : t('notif.none')}
              </p>
            )}
          </CardContent>
        </Card>
        <Preferences />
      </div>
    </>
  );
}

function Preferences() {
  const uid = useAuth((s) => s.user?.id);
  const qc = useQueryClient();
  const prefs = useNotificationPrefs();
  const t = useT();
  const save = useMutation({
    mutationFn: (patch: Record<string, EmailDelivery>) =>
      api<NotificationPref[]>('/notifications/preferences', { method: 'PUT', body: patch }),
    onSuccess: (p) => (
      qc.setQueryData(['notifications', uid, 'prefs'], p),
      toast.success(t('notif.prefsSaved'))
    ),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('notif.emailMe')}</CardTitle>
        <CardDescription>{t('notif.emailHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {prefs.data?.map((p) => (
          <div key={p.type} className="flex items-center justify-between gap-3">
            <label htmlFor={`pref-${p.type}`} className="text-sm">
              {t(`notif.type.${p.type}` as MessageKey) || p.label}
            </label>
            <Select
              id={`pref-${p.type}`}
              className="w-36 shrink-0"
              value={p.email}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ [p.type]: e.target.value as EmailDelivery })}
            >
              {(Object.keys(DELIVERY_LABEL) as EmailDelivery[]).map((d) => (
                <option key={d} value={d}>
                  {t(DELIVERY_LABEL[d])}
                  {d === p.default ? ` ${t('notif.default')}` : ''}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
