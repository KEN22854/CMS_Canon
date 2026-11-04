'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';

const EVENTS = ['order.placed', 'form.submitted'] as const;
type Status = { connected: false } | { connected: true; chatId: string; events: string[]; tokenHint: string; botName: string | null };

export function TelegramCard({ siteId }: { siteId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const key = ['telegram', tid, siteId];
  const status = useQuery({ queryKey: key, queryFn: () => api<Status>(`/sites/${siteId}/integrations/telegram`), enabled: Boolean(tid) });
  const s = status.data;
  const [token, setToken] = useState('');
  const [chat, setChat] = useState<string | null>(null);
  const [events, setEvents] = useState<string[] | null>(null);
  const chatValue = chat ?? (s?.connected ? s.chatId : '');
  const eventsValue = events ?? (s?.connected ? s.events : [...EVENTS]);
  const canEdit = ability.can('update', 'Site');
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: () => api<Status>(`/sites/${siteId}/integrations/telegram`, { method: 'PUT', body: { ...(token.trim() ? { botToken: token.trim() } : {}), chatId: chatValue.trim(), events: eventsValue } }),
    onSuccess: () => (toast.success(t('tg.saved')), setToken(''), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({ mutationFn: () => api(`/sites/${siteId}/integrations/telegram/test`, { body: {} }), onSuccess: () => toast.success(t('tg.tested')), onError: (e) => toast.error(errorMessage(e)) });
  const off = useMutation({
    mutationFn: () => api(`/sites/${siteId}/integrations/telegram`, { method: 'DELETE' }),
    onSuccess: () => (toast.success(t('tg.disconnected')), setChat(null), setEvents(null), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-4 w-4 text-primary" /> {t('tg.title')}
        </CardTitle>
        <CardDescription>{t('tg.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {s?.connected && <p className="text-sm font-medium text-success">{t('tg.connected', { bot: s.botName ?? 'bot', chat: s.chatId })}</p>}
        <p className="text-xs text-muted-foreground">{t('tg.how')}</p>
        <form
          className="space-y-3"
          aria-label={t('tg.title')}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tg-token">{t('tg.token')}</Label>
              <Input id="tg-token" type="password" autoComplete="off" disabled={!canEdit} placeholder={s?.connected ? t('tg.tokenKeep', { hint: s.tokenHint }) : '123456:ABC…'} value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tg-chat">{t('tg.chat')}</Label>
              <Input id="tg-chat" disabled={!canEdit} placeholder="-1001234567890" value={chatValue} onChange={(e) => setChat(e.target.value)} />
            </div>
          </div>
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="mb-1 text-sm font-medium">{t('tg.events')}</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-2">
                <input type="checkbox" disabled={!canEdit} checked={eventsValue.includes(ev)} onChange={() => setEvents(eventsValue.includes(ev) ? eventsValue.filter((x) => x !== ev) : [...eventsValue, ev])} /> {t(`tg.event.${ev}` as MessageKey)}
              </label>
            ))}
          </fieldset>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={!chatValue.trim() || (!s?.connected && !token.trim())} loading={save.isPending}>
                {s?.connected ? t('tg.save') : t('tg.connect')}
              </Button>
              {s?.connected && (
                <>
                  <Button type="button" size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
                    {t('tg.test')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="text-destructive" loading={off.isPending} onClick={() => off.mutate()}>
                    {t('tg.disconnect')}
                  </Button>
                </>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
