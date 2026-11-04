'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';

type Step = { kind: 'page'; path: string; label?: string } | { kind: 'event'; name: string; label?: string };
interface Funnel {
  id: string;
  name: string;
  window: 'session' | number;
  steps: Step[];
  result: { steps: { label: string; visitors: number; ofFirst: number; fromPrevious: number }[]; conversion: number };
}

export function Funnels({ siteId, from, to }: { siteId: string; from: string; to: string }) {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const key = ['funnels', tid, siteId, from, to];
  const list = useQuery({ queryKey: key, queryFn: () => api<Funnel[]>(`/sites/${siteId}/analytics/funnels?from=${from}&to=${to}`), enabled: Boolean(tid) });
  const [draft, setDraft] = useState<{ name: string; window: 'session' | number; steps: Step[] } | null>(null);
  const pct = (x: number) => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(x);
  const save = useMutation({
    mutationFn: () => api(`/sites/${siteId}/analytics/funnels`, { body: draft }),
    onSuccess: () => (toast.success(t('funnel.saved')), setDraft(null), void qc.invalidateQueries({ queryKey: ['funnels', tid, siteId] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const drop = useMutation({
    mutationFn: (id: string) => api(`/sites/${siteId}/analytics/funnels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['funnels', tid, siteId] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canEdit = ability.can('update', 'Site');
  const setStep = (i: number, s: Step) => draft && setDraft({ ...draft, steps: draft.steps.map((x, j) => (j === i ? s : x)) });
  const validStep = (s: Step) => (s.kind === 'page' ? /^\/\S*$/.test(s.path) : /^[a-z0-9_.:-]{1,60}$/i.test(s.name));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{t('funnel.title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('funnel.intro')}</p>
        </div>
        {canEdit && !draft && (
          <Button size="sm" variant="outline" onClick={() => setDraft({ name: '', window: 7, steps: [{ kind: 'page', path: '/' }, { kind: 'event', name: 'cta_click' }] })}>
            <Plus className="h-4 w-4" /> {t('funnel.new')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {draft && (
          <form
            aria-label={t('funnel.new')}
            className="space-y-3 rounded-md border border-primary/40 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Input aria-label={t('funnel.name')} placeholder={t('funnel.name')} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <Select aria-label={t('funnel.window')} value={String(draft.window)} onChange={(e) => setDraft({ ...draft, window: e.target.value === 'session' ? 'session' : Number(e.target.value) })}>
                <option value="session">{t('funnel.window.session')}</option>
                {[1, 7, 30].map((d) => (
                  <option key={d} value={d}>
                    {t('funnel.window.days', { days: d })}
                  </option>
                ))}
              </Select>
            </div>
            {draft.steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-14 text-xs text-muted-foreground">{t('funnel.step', { n: i + 1 })}</span>
                <Select aria-label={`${t('funnel.step', { n: i + 1 })}`} value={s.kind} onChange={(e) => setStep(i, e.target.value === 'page' ? { kind: 'page', path: '/' } : { kind: 'event', name: '' })}>
                  <option value="page">{t('funnel.kind.page')}</option>
                  <option value="event">{t('funnel.kind.event')}</option>
                </Select>
                {s.kind === 'page' ? (
                  <Input className="min-w-56 flex-1" aria-label={`${t('funnel.path')} ${i + 1}`} placeholder={t('funnel.path')} value={s.path} onChange={(e) => setStep(i, { ...s, path: e.target.value.trim() })} />
                ) : (
                  <Input className="min-w-56 flex-1" aria-label={`${t('funnel.event')} ${i + 1}`} placeholder={t('funnel.event')} value={s.name} onChange={(e) => setStep(i, { ...s, name: e.target.value.trim() })} />
                )}
                {draft.steps.length > 2 && (
                  <button type="button" aria-label={t('funnel.removeStep', { n: i + 1 })} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) })} className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {draft.steps.length < 6 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { kind: 'event', name: '' }] })}>
                  <Plus className="h-3.5 w-3.5" /> {t('funnel.addStep')}
                </Button>
              )}
              <Button type="submit" size="sm" disabled={!draft.name.trim() || !draft.steps.every(validStep)} loading={save.isPending}>
                {t('funnel.save')}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {t('funnel.cancel')}
              </Button>
            </div>
          </form>
        )}
        {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
        {list.data?.length === 0 && !draft && <p className="text-sm text-muted-foreground">{t('funnel.empty')}</p>}
        {list.data?.map((f) => (
          <section key={f.id} aria-label={f.name} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">
                {f.name} <span className="ml-1 text-xs font-normal text-muted-foreground">{f.window === 'session' ? t('funnel.window.session') : t('funnel.window.days', { days: f.window })} · {t('funnel.conversion', { pct: pct(f.result.conversion) })}</span>
              </p>
              {canEdit && (
                <button type="button" aria-label={t('funnel.delete', { name: f.name })} onClick={() => window.confirm(t('funnel.delete', { name: f.name }) + '?') && drop.mutate(f.id)} className="rounded p-1 text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <ol className="space-y-1.5">
              {f.result.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[minmax(8rem,14rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate" title={s.label}>
                    {i + 1}. {s.label}
                  </span>
                  <div className="h-6 rounded bg-muted" role="img" aria-label={`${s.label}: ${t('funnel.visitors', { count: s.visitors })}, ${t('funnel.ofFirst', { pct: pct(s.ofFirst) })}`}>
                    <div className="h-6 rounded bg-primary/70" style={{ width: `${Math.max(s.visitors ? 2 : 0, s.ofFirst * 100)}%` }} />
                  </div>
                  <span className="w-44 text-right text-xs tabular-nums text-muted-foreground">
                    {t('funnel.visitors', { count: s.visitors })}
                    {i > 0 && s.fromPrevious < 1 && <span className="ml-1 text-warning">{t('funnel.drop', { pct: pct(1 - s.fromPrevious) })}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
