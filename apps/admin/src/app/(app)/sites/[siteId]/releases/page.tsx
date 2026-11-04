'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, X } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';

interface Release {
  id: string;
  number: number;
  note: string | null;
  automatic: boolean;
  pageCount: number;
  componentCount: number;
  entryCount: number;
  createdAt: string;
}
interface ReleaseDetail extends Release {
  changes: { restored: { title: string; path: string; from: number | null; to: number }[]; unpublished: { title: string; path: string }[]; missing: { title: string; path: string }[]; components: number; entries: number };
}

export default function ReleasesPage() {
  const t = useT();
  const locale = useLocale();
  const { siteId } = useParams<{ siteId: string }>();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const key = ['releases', tid, siteId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Release[]>(`/sites/${siteId}/releases`), enabled: Boolean(tid) });
  const [open, setOpen] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (note?: string) => api<Release>(`/sites/${siteId}/releases`, { body: { ...(note ? { note } : {}) } }),
    onSuccess: (r) => (toast.success(t('rel.created', { number: r.number })), void qc.invalidateQueries({ queryKey: key })),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('rel.intro')}</p>
        {ability.can('publish', 'Page') && (
          <Button size="sm" loading={create.isPending} onClick={() => create.mutate(window.prompt(t('rel.notePrompt'))?.trim() || undefined)}>
            <History className="h-4 w-4" /> {t('rel.create')}
          </Button>
        )}
      </div>
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <ol className="space-y-2">
        {list.data?.map((r) => (
          <li key={r.id} className="rounded-md border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">
                  {t('rel.title', { number: r.number })} {r.automatic && <Badge className="ml-1 text-[10px]">{t('rel.auto')}</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString(locale)}
                  {r.note ? ` · ${r.note}` : ''} · {t('rel.counts', { pages: r.pageCount, components: r.componentCount, entries: r.entryCount })}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setOpen(open === r.id ? null : r.id)}>
                {t('rel.review')}
              </Button>
            </div>
            {open === r.id && <Review siteId={siteId} id={r.id} onClose={() => setOpen(null)} canRollback={ability.can('update', 'Site')} />}
          </li>
        ))}
      </ol>
      {list.data?.length === 0 && <p className="rounded-md border p-10 text-center text-sm text-muted-foreground">{t('rel.empty')}</p>}
    </>
  );
}

function Review({ siteId, id, onClose, canRollback }: { siteId: string; id: string; onClose: () => void; canRollback: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const tid = useTenantId();
  const detail = useQuery({ queryKey: ['release', tid, id], queryFn: () => api<ReleaseDetail>(`/sites/${siteId}/releases/${id}`), enabled: Boolean(tid) });
  const rollback = useMutation({
    mutationFn: () => api<{ restored: number; unpublished: number; backup: { number: number } }>(`/sites/${siteId}/releases/${id}/rollback`, { body: {} }),
    onSuccess: (r) => {
      toast.success(t('rel.rolledBack', { restored: r.restored, unpublished: r.unpublished, backup: r.backup.number }));
      void qc.invalidateQueries({ queryKey: ['releases', tid, siteId] });
      void qc.invalidateQueries({ queryKey: ['release'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = detail.data;
  const c = d?.changes;
  const nothing = c && !c.restored.length && !c.unpublished.length && !c.components && !c.entries;
  return (
    <section aria-label={d ? t('rel.title', { number: d.number }) : '…'} className="mt-3 space-y-3 border-t pt-3 text-sm">
      <div className="flex justify-end">
        <button type="button" aria-label={t('rel.close')} onClick={onClose} className="rounded p-1 hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </div>
      {detail.isError && <Alert tone="error">{errorMessage(detail.error)}</Alert>}
      {c && (
        <>
          {nothing && <p className="text-muted-foreground">{t('rel.nothing')}</p>}
          <Group title={t('rel.restored')} items={c.restored.map((p) => `${p.title} — ${p.path} (v${p.from ?? '—'} → v${p.to})`)} />
          <Group title={t('rel.unpublished')} items={c.unpublished.map((p) => `${p.title} — ${p.path}`)} tone="text-warning" />
          <Group title={t('rel.missing')} items={c.missing.map((p) => `${p.title} — ${p.path}`)} tone="text-muted-foreground" />
          {c.components > 0 && <p>{t('rel.components', { count: c.components })}</p>}
          {c.entries > 0 && <p>{t('rel.entries', { count: c.entries })}</p>}
          <p className="text-[11px] text-muted-foreground">{t('rel.urlsNote')}</p>
          {canRollback && !nothing && (
            <Button size="sm" variant="destructive" loading={rollback.isPending} onClick={() => window.confirm(t('rel.rollbackConfirm', { number: d!.number })) && rollback.mutate()}>
              {t('rel.rollback', { number: d!.number })}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function Group({ title, items, tone }: { title: string; items: string[]; tone?: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className={`mb-1 text-xs font-medium uppercase ${tone ?? 'text-muted-foreground'}`}>{title}</p>
      <ul className="list-inside list-disc space-y-0.5">
        {items.slice(0, 50).map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
