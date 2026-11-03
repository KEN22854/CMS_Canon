import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth-store';

export interface AppNotification {
  id: string;
  tenantId: string | null;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export type EmailDelivery = 'instant' | 'digest' | 'off';
export interface NotificationPref {
  type: string;
  label: string;
  email: EmailDelivery;
  default: EmailDelivery;
}

/** Notifications belong to the person, not the workspace, so keys are per user. */
const key = (uid: string | undefined) => ['notifications', uid] as const;

export function useUnreadCount() {
  const uid = useAuth((s) => s.user?.id);
  return useQuery({
    queryKey: [...key(uid), 'unread'],
    queryFn: () => api<{ unread: number }>('/notifications/unread-count'),
    enabled: Boolean(uid),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useNotifications(unreadOnly = false) {
  const uid = useAuth((s) => s.user?.id);
  return useQuery({
    queryKey: [...key(uid), 'list', unreadOnly],
    queryFn: () =>
      api<{ items: AppNotification[]; nextCursor: string | null; unread: number }>(
        `/notifications?limit=30${unreadOnly ? '&unread=true' : ''}`,
      ),
    enabled: Boolean(uid),
  });
}

export function useMarkRead() {
  const uid = useAuth((s) => s.user?.id);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') =>
      api<{ updated: number }>('/notifications/read', { body: ids === 'all' ? { all: true } : { ids } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key(uid) }),
  });
}

export function useNotificationPrefs() {
  const uid = useAuth((s) => s.user?.id);
  return useQuery({
    queryKey: [...key(uid), 'prefs'],
    queryFn: () => api<NotificationPref[]>('/notifications/preferences'),
    enabled: Boolean(uid),
  });
}
