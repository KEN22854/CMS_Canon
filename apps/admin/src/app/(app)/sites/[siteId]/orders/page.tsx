'use client';

import { formatMoney } from '@canon/blocks';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingBag, X } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Input } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useLocale, useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

const PAGE = 25;
const STATUSES = ['NEW', 'CONFIRMED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'] as const;
type Status = (typeof STATUSES)[number];

interface Order {
  id: string;
  number: number;
  status: Status;
  currency: string;
  subtotal: number;
  total: number;
  items: { entryId: string; title: string; sku: string | null; unitPrice: number; quantity: number; lineTotal: number }[];
  customer: { name: string; email: string; phone?: string; address?: string; note?: string };
  paymentMethod: string;
  history: { at: string; status: Status; by: string; note?: string }[];
  allowed: Status[];
  createdAt: string;
}

const TONE: Record<Status, string> = {
  NEW: 'border-primary/40 text-primary',
  CONFIRMED: 'border-accent/40 text-accent',
  PAID: 'border-success/40 text-success',
  SHIPPED: 'border-warning/40 text-warning',
  COMPLETED: 'border-border text-muted-foreground',
  CANCELLED: 'border-destructive/40 text-destructive',
};

export default function OrdersPage() {
  const t = useT();
  const locale = useLocale();
  const { siteId } = useParams<{ siteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tid = useTenantId();
  const [status, setStatus] = useState<Status | ''>('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [offset, setOffset] = useState(0);
  const openId = params.get('order');

  useEffect(() => {
    const timer = setTimeout(() => (setDebounced(q.trim()), setOffset(0)), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(status ? { status } : {}), ...(debounced ? { q: debounced } : {}) });
  const orders = useQuery({
    queryKey: ['orders', tid, siteId, qs.toString()],
    queryFn: () => api<{ items: Order[]; total: number; counts: Partial<Record<Status, number>> }>(`/sites/${siteId}/orders?${qs}`),
    enabled: Boolean(tid),
    placeholderData: keepPreviousData,
  });
  const money = (o: { currency: string }, n: number) => formatMoney(n, o.currency, locale);
  const open = (id: string | null) => router.replace(id ? `/sites/${siteId}/orders?order=${id}` : `/sites/${siteId}/orders`, { scroll: false });
  const counts = orders.data?.counts ?? {};
  const all = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  const total = orders.data?.total ?? 0;

  return (
    <>
      <nav aria-label={t('site.orders')} className="mb-3 flex flex-wrap gap-1 border-b">
        {(['', ...STATUSES] as const).map((s) => (
          <button
            key={s || 'all'}
            type="button"
            aria-current={status === s ? 'true' : undefined}
            onClick={() => (setStatus(s), setOffset(0))}
            className={cn('-mb-px border-b-2 px-3 py-1.5 text-sm', status === s ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {s ? t(`orders.status.${s}` as MessageKey) : t('orders.all')} <span className="text-xs opacity-60">{s ? (counts[s] ?? 0) : all}</span>
          </button>
        ))}
      </nav>
      <Input className="mb-3 h-9 w-72" placeholder={t('orders.search')} aria-label={t('orders.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      {orders.isError && <Alert tone="error">{errorMessage(orders.error)}</Alert>}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('orders.col.number')}</th>
              <th className="px-3 py-2 font-medium">{t('orders.col.customer')}</th>
              <th className="px-3 py-2 font-medium">{t('orders.col.items')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('orders.col.total')}</th>
              <th className="px-3 py-2 font-medium">{t('orders.col.status')}</th>
              <th className="px-3 py-2 font-medium">{t('orders.col.placed')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {orders.data?.items.map((o) => (
              <tr key={o.id} className={cn('cursor-pointer hover:bg-muted/30', openId === o.id && 'bg-primary/5')} onClick={() => open(o.id)}>
                <td className="px-3 py-2">
                  <button type="button" className="font-medium hover:text-primary hover:underline" onClick={(e) => (e.stopPropagation(), open(o.id))}>
                    #{o.number}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <p>{o.customer.name}</p>
                  <p className="text-xs text-muted-foreground">{o.customer.email}</p>
                </td>
                <td className="max-w-xs truncate px-3 py-2 text-muted-foreground">{t('orders.itemsCount', { count: o.items.reduce((s, i) => s + i.quantity, 0) })} · {o.items.map((i) => i.title).join(', ')}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{money(o, o.total)}</td>
                <td className="px-3 py-2">
                  <Badge className={TONE[o.status]}>{t(`orders.status.${o.status}` as MessageKey)}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{relativeTime(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.data?.items.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <ShoppingBag className="h-6 w-6" aria-hidden />
            {status || debounced ? t('orders.emptyFiltered') : t('orders.empty')}
          </div>
        )}
      </div>
      {total > PAGE && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t('orders.prev')}
          </Button>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            {t('orders.next')}
          </Button>
        </div>
      )}
      {openId && <OrderPanel siteId={siteId} id={openId} onClose={() => open(null)} />}
    </>
  );
}

function OrderPanel({ siteId, id, onClose }: { siteId: string; id: string; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const [note, setNote] = useState('');
  const order = useQuery({ queryKey: ['order', tid, id], queryFn: () => api<Order>(`/sites/${siteId}/orders/${id}`), enabled: Boolean(tid) });
  const move = useMutation({
    mutationFn: (status: Status) => api<Order>(`/sites/${siteId}/orders/${id}`, { method: 'PATCH', body: { status, ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: (o) => {
      toast.success(t('orders.moved', { number: o.number, status: t(`orders.status.${o.status}` as MessageKey) }));
      setNote('');
      qc.setQueryData(['order', tid, id], o);
      void qc.invalidateQueries({ queryKey: ['orders', tid, siteId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const o = order.data;
  const money = (n: number) => (o ? formatMoney(n, o.currency, locale) : '');

  return (
    <aside role="dialog" aria-modal="false" aria-label={o ? t('orders.detail', { number: o.number }) : '…'} className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l bg-card p-5 shadow-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{o ? t('orders.detail', { number: o.number }) : '…'}</h2>
        <button type="button" aria-label={t('orders.close')} onClick={onClose} className="rounded p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>
      {order.isError && <Alert tone="error">{errorMessage(order.error)}</Alert>}
      {o && (
        <div className="space-y-5 text-sm">
          <Badge className={TONE[o.status]}>{t(`orders.status.${o.status}` as MessageKey)}</Badge>
          <ul className="divide-y rounded-md border">
            {o.items.map((i) => (
              <li key={i.entryId} className="flex justify-between gap-3 px-3 py-2">
                <span>
                  {i.quantity} × {i.title}
                  {i.sku && <span className="ml-1 font-mono text-[11px] text-muted-foreground">{i.sku}</span>}
                </span>
                <span className="tabular-nums">{money(i.lineTotal)}</span>
              </li>
            ))}
            <li className="flex justify-between px-3 py-2 font-semibold">
              <span>{t('orders.col.total')}</span>
              <span className="tabular-nums">{money(o.total)}</span>
            </li>
          </ul>
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('orders.customer')}</h3>
            <p className="font-medium">{o.customer.name}</p>
            <p>
              <a href={`mailto:${o.customer.email}`} className="text-primary hover:underline">
                {o.customer.email}
              </a>
              {o.customer.phone && <> · {o.customer.phone}</>}
            </p>
            {o.customer.address && <p className="whitespace-pre-line text-muted-foreground">{o.customer.address}</p>}
            {o.customer.note && <p className="mt-1 rounded bg-muted px-2 py-1">{o.customer.note}</p>}
          </section>
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('orders.payment')}</h3>
            <p>{t(`shop.method.${o.paymentMethod}` as MessageKey)}</p>
          </section>
          {ability.can('update', 'Order') && o.allowed.length > 0 && (
            <section className="space-y-2">
              <Input aria-label={t('orders.note')} placeholder={t('orders.note')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              <div className="flex flex-wrap gap-2">
                {o.allowed.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={s === 'CANCELLED' ? 'ghost' : 'default'}
                    className={s === 'CANCELLED' ? 'text-destructive' : undefined}
                    loading={move.isPending && move.variables === s}
                    onClick={() => (s !== 'CANCELLED' || window.confirm(t('orders.cancelConfirm', { number: o.number }))) && move.mutate(s)}
                  >
                    {t(`orders.action.${s}` as MessageKey)}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('orders.history')}</h3>
            <ol className="space-y-1">
              {o.history.map((h, i) => (
                <li key={i} className="text-xs">
                  <span className="text-muted-foreground">{new Date(h.at).toLocaleString(locale)}</span> · {t(`orders.status.${h.status}` as MessageKey)} · {h.by === 'customer' ? t('orders.by.customer') : t('orders.by.staff')}
                  {h.note && <> — {h.note}</>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </aside>
  );
}
