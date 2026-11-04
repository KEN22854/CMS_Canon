'use client';

import { formatMoney } from '@canon/blocks';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, X } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useLocale, useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

const PAGE = 25;

interface Contact {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  tags: string[];
  orderCount: number;
  revenue: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
}
interface ContactDetail extends Contact {
  activities: { id: string; kind: string; title: string; data: Record<string, unknown>; createdAt: string }[];
}

export default function ContactsPage() {
  const t = useT();
  const locale = useLocale();
  const { siteId } = useParams<{ siteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tid = useTenantId();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [customers, setCustomers] = useState(false);
  const [offset, setOffset] = useState(0);
  const openId = params.get('contact');

  useEffect(() => {
    const timer = setTimeout(() => (setDebounced(q.trim()), setOffset(0)), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(debounced ? { q: debounced } : {}), ...(tag ? { tag } : {}), ...(customers ? { customers: 'true' } : {}) });
  const list = useQuery({
    queryKey: ['contacts', tid, siteId, qs.toString()],
    queryFn: () => api<{ items: Contact[]; total: number; tags: { tag: string; count: number }[] }>(`/sites/${siteId}/contacts?${qs}`),
    enabled: Boolean(tid),
    placeholderData: keepPreviousData,
  });
  const open = (id: string | null) => router.replace(id ? `/sites/${siteId}/contacts?contact=${id}` : `/sites/${siteId}/contacts`, { scroll: false });
  const spent = (c: Contact) => Object.entries(c.revenue).filter(([, n]) => n > 0).map(([cur, n]) => formatMoney(n, cur, locale)).join(' · ') || '—';
  const total = list.data?.total ?? 0;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input className="h-9 w-72" placeholder={t('crm.search')} aria-label={t('crm.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={customers} onChange={(e) => (setCustomers(e.target.checked), setOffset(0))} /> {t('crm.customersOnly')}
        </label>
      </div>
      {(list.data?.tags.length ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {list.data!.tags.map((x) => (
            <button key={x.tag} type="button" onClick={() => (setTag(tag === x.tag ? null : x.tag), setOffset(0))} className={cn('rounded-full border px-2 py-0.5 text-xs', tag === x.tag ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:border-primary')}>
              #{x.tag} <span className="opacity-60">{x.count}</span>
            </button>
          ))}
        </div>
      )}
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('crm.col.contact')}</th>
              <th className="px-3 py-2 font-medium">{t('crm.col.tags')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('crm.col.orders')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('crm.col.spent')}</th>
              <th className="px-3 py-2 font-medium">{t('crm.col.seen')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {list.data?.items.map((c) => (
              <tr key={c.id} className={cn('cursor-pointer hover:bg-muted/30', openId === c.id && 'bg-primary/5')} onClick={() => open(c.id)}>
                <td className="px-3 py-2">
                  <button type="button" className="font-medium hover:text-primary hover:underline" onClick={(e) => (e.stopPropagation(), open(c.id))}>
                    {c.name || c.email}
                  </button>
                  {c.name && <p className="text-xs text-muted-foreground">{c.email}</p>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex max-w-60 flex-wrap gap-1">
                    {c.tags.map((x) => (
                      <span key={x} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                        {x}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{c.orderCount}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{spent(c)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{relativeTime(c.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.items.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Users className="h-6 w-6" aria-hidden />
            {debounced || tag || customers ? t('crm.emptyFiltered') : t('crm.empty')}
          </div>
        )}
      </div>
      {total > PAGE && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t('crm.prev')}
          </Button>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            {t('crm.next')}
          </Button>
        </div>
      )}
      {openId && <ContactPanel key={openId} siteId={siteId} id={openId} onClose={() => open(null)} />}
    </>
  );
}

function ContactPanel({ siteId, id, onClose }: { siteId: string; id: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const contact = useQuery({ queryKey: ['contact', tid, id], queryFn: () => api<ContactDetail>(`/sites/${siteId}/contacts/${id}`), enabled: Boolean(tid) });
  const [form, setForm] = useState<{ name: string; phone: string; tags: string } | null>(null);
  const [note, setNote] = useState('');
  const c = contact.data;
  useEffect(() => {
    if (c && !form) setForm({ name: c.name ?? '', phone: c.phone ?? '', tags: c.tags.join(', ') });
  }, [c, form]);
  const refresh = (next: ContactDetail) => {
    qc.setQueryData(['contact', tid, id], next);
    void qc.invalidateQueries({ queryKey: ['contacts', tid, siteId] });
  };
  const save = useMutation({
    mutationFn: () => api<ContactDetail>(`/sites/${siteId}/contacts/${id}`, { method: 'PATCH', body: { name: form!.name, phone: form!.phone, tags: form!.tags.split(',').map((x) => x.trim()).filter(Boolean) } }),
    onSuccess: (next) => (refresh(next), toast.success(t('crm.saved'))),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addNote = useMutation({
    mutationFn: () => api<ContactDetail>(`/sites/${siteId}/contacts/${id}/notes`, { body: { text: note.trim() } }),
    onSuccess: (next) => (refresh(next), setNote('')),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const erase = useMutation({
    mutationFn: () => api(`/sites/${siteId}/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast.success(t('crm.erased')), void qc.invalidateQueries({ queryKey: ['contacts', tid, siteId] }), onClose()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canEdit = ability.can('update', 'Contact');

  return (
    <aside role="dialog" aria-modal="false" aria-label={c?.name || c?.email || '…'} className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l bg-card p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{c?.name || c?.email || '…'}</h2>
          {c && (
            <p className="text-xs text-muted-foreground">
              <a href={`mailto:${c.email}`} className="text-primary hover:underline">
                {c.email}
              </a>{' '}
              · {t('crm.firstSeen', { date: new Date(c.firstSeenAt).toLocaleDateString(locale) })}
            </p>
          )}
        </div>
        <button type="button" aria-label={t('crm.close')} onClick={onClose} className="rounded p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>
      {contact.isError && <Alert tone="error">{errorMessage(contact.error)}</Alert>}
      {c && form && (
        <div className="space-y-5 text-sm">
          {canEdit && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ct-name">{t('crm.name')}</Label>
                  <Input id="ct-name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ct-phone">{t('crm.phone')}</Label>
                  <Input id="ct-phone" value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ct-tags">{t('crm.tags')}</Label>
                <Input id="ct-tags" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </div>
              <Button size="sm" type="submit" loading={save.isPending}>
                {t('crm.save')}
              </Button>
            </form>
          )}
          {!canEdit && c.tags.length > 0 && <p>{c.tags.map((x) => `#${x}`).join(' ')}</p>}

          <section>
            <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">{t('crm.timeline')}</h3>
            {canEdit && (
              <div className="mb-3 flex gap-2">
                <Input aria-label={t('crm.note')} placeholder={t('crm.note')} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
                <Button size="sm" variant="outline" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>
                  {t('crm.addNote')}
                </Button>
              </div>
            )}
            <ol className="space-y-2 border-l pl-3">
              {c.activities.map((a) => (
                <li key={a.id}>
                  <div className="flex items-center gap-2">
                    <Badge className="text-[10px]">{t(`crm.kind.${a.kind}` as MessageKey) || a.kind}</Badge>
                    <span className="text-xs text-muted-foreground">{relativeTime(a.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-line">{a.kind === 'note' ? String(a.data.text ?? a.title) : a.title}</p>
                </li>
              ))}
            </ol>
          </section>

          {ability.can('delete', 'Contact') && (
            <Button size="sm" variant="ghost" className="text-destructive" loading={erase.isPending} onClick={() => window.confirm(t('crm.eraseConfirm', { email: c.email })) && erase.mutate()}>
              {t('crm.erase')}
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
