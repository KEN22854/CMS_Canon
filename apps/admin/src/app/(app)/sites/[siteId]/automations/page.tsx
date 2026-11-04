'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Workflow, X } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useForms } from '@/lib/forms';
import { useLocale, useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

type Event = 'form.submitted' | 'order.placed' | 'order.status';
type Action = { type: 'email_contact'; subject: string; body: string } | { type: 'email_team'; to: string; subject: string; body: string } | { type: 'add_tag'; tag: string } | { type: 'telegram'; text: string };
interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { event: Event; formId?: string; status?: string; minTotal?: number };
  actions: Action[];
  runCount: number;
  lastRunAt: string | null;
}
type Draft = Omit<Automation, 'id' | 'runCount' | 'lastRunAt'> & { id?: string };

const EVENTS: Event[] = ['form.submitted', 'order.placed', 'order.status'];
const STATUSES = ['CONFIRMED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'];
const VARS = ['{{contact.name}}', '{{contact.email}}', '{{site.name}}', '{{form.name}}', '{{order.number}}', '{{order.total}}', '{{order.status}}'];
const blankAction = (type: Action['type']): Action => (type === 'add_tag' ? { type, tag: '' } : type === 'telegram' ? { type, text: '' } : type === 'email_team' ? { type, to: '', subject: '', body: '' } : { type, subject: '', body: '' });

export default function AutomationsPage() {
  const t = useT();
  const locale = useLocale();
  const { siteId } = useParams<{ siteId: string }>();
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const key = ['automations', tid, siteId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Automation[]>(`/sites/${siteId}/automations`), enabled: Boolean(tid) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runsOf, setRunsOf] = useState<string | null>(null);
  const canEdit = ability.can('update', 'Automation');

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const { id, ...body } = d;
      return id ? api<Automation>(`/sites/${siteId}/automations/${id}`, { method: 'PATCH', body }) : api<Automation>(`/sites/${siteId}/automations`, { body });
    },
    onSuccess: () => (toast.success(t('auto.saved')), setDraft(null), void qc.invalidateQueries({ queryKey: key })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (a: Automation) => api<Automation>(`/sites/${siteId}/automations/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sites/${siteId}/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('auto.intro')}</p>
        {ability.can('create', 'Automation') && !draft && (
          <Button size="sm" onClick={() => setDraft({ name: '', enabled: true, trigger: { event: 'form.submitted' }, actions: [blankAction('email_contact')] })}>
            <Plus className="h-4 w-4" /> {t('auto.new')}
          </Button>
        )}
      </div>
      {draft && <Editor siteId={siteId} draft={draft} setDraft={setDraft} saving={save.isPending} onSave={() => save.mutate(draft)} />}
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <ul className="space-y-2">
        {list.data?.map((a) => (
          <li key={a.id} className="rounded-md border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`auto.event.${a.trigger.event}` as MessageKey)}
                  {a.trigger.status ? ` → ${a.trigger.status}` : ''} → {a.actions.map((x) => t(`auto.action.${x.type}` as MessageKey)).join(', ')} · {t('auto.runs', { count: a.runCount })}
                  {a.lastRunAt ? `, ${t('auto.lastRun', { date: relativeTime(a.lastRunAt) })}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" role="switch" aria-checked={a.enabled} aria-label={t('auto.toggle', { name: a.name })} disabled={!canEdit} onClick={() => toggle.mutate(a)} className={cn('rounded-full border px-2 py-0.5 text-xs', a.enabled ? 'border-success/40 text-success' : 'text-muted-foreground')}>
                  {a.enabled ? t('auto.enabled') : t('auto.disabled')}
                </button>
                <Button size="sm" variant="ghost" onClick={() => setRunsOf(runsOf === a.id ? null : a.id)}>
                  {t('auto.history')}
                </Button>
                {canEdit && (
                  <Button size="sm" variant="outline" onClick={() => setDraft({ id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, actions: a.actions })}>
                    {t('auto.edit')}
                  </Button>
                )}
                {ability.can('delete', 'Automation') && (
                  <Button size="icon" variant="ghost" aria-label={`${t('auto.delete')}: ${a.name}`} onClick={() => window.confirm(t('auto.deleteConfirm', { name: a.name })) && remove.mutate(a.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
            {runsOf === a.id && <Runs siteId={siteId} id={a.id} locale={locale} />}
          </li>
        ))}
      </ul>
      {list.data?.length === 0 && !draft && (
        <div className="flex flex-col items-center gap-2 rounded-md border p-10 text-center text-sm text-muted-foreground">
          <Workflow className="h-6 w-6" aria-hidden />
          {t('auto.empty')}
        </div>
      )}
    </>
  );
}

function Runs({ siteId, id, locale }: { siteId: string; id: string; locale: string }) {
  const t = useT();
  const tid = useTenantId();
  const runs = useQuery({ queryKey: ['runs', tid, id], queryFn: () => api<{ id: string; status: string; createdAt: string; detail: { actions?: string[] } }[]>(`/sites/${siteId}/automations/${id}/runs`), enabled: Boolean(tid) });
  return (
    <ol className="mt-3 space-y-1 border-t pt-3 text-xs">
      {runs.data?.map((r) => (
        <li key={r.id} className="flex gap-2">
          <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString(locale)}</span>
          <Badge className={r.status === 'ok' ? 'border-success/40 text-success' : r.status === 'failed' ? 'border-destructive/40 text-destructive' : ''}>{t(`auto.run.${r.status}` as MessageKey)}</Badge>
          <span>{(r.detail.actions ?? []).map((x) => t(`auto.action.${x}` as MessageKey)).join(', ')}</span>
        </li>
      ))}
      {runs.data?.length === 0 && <li className="text-muted-foreground">—</li>}
    </ol>
  );
}

function Editor({ siteId, draft, setDraft, saving, onSave }: { siteId: string; draft: Draft; setDraft: (d: Draft | null) => void; saving: boolean; onSave: () => void }) {
  const t = useT();
  const forms = useForms(siteId);
  const tr = draft.trigger;
  const setTrigger = (patch: Partial<Draft['trigger']>) => setDraft({ ...draft, trigger: { ...tr, ...patch } });
  const setAction = (i: number, next: Action) => setDraft({ ...draft, actions: draft.actions.map((a, j) => (j === i ? next : a)) });
  const valid = draft.name.trim() && draft.actions.length > 0 && draft.actions.every((a) => (a.type === 'add_tag' ? a.tag.trim() : a.type === 'telegram' ? a.text.trim() : a.subject.trim() && a.body.trim() && (a.type !== 'email_team' || /.+@.+\..+/.test(a.to))));

  return (
    <form
      aria-label={t('auto.new')}
      className="mb-4 space-y-4 rounded-md border border-primary/40 bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="au-name">{t('auto.name')}</Label>
        <Input id="au-name" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">{t('auto.when')}</legend>
        <Select aria-label={t('auto.when')} value={tr.event} onChange={(e) => setDraft({ ...draft, trigger: { event: e.target.value as Event } })}>
          {EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {t(`auto.event.${ev}` as MessageKey)}
            </option>
          ))}
        </Select>
        {tr.event === 'form.submitted' && (
          <Select aria-label={t('auto.form')} value={tr.formId ?? ''} onChange={(e) => setTrigger({ formId: e.target.value || undefined })}>
            <option value="">{t('auto.anyForm')}</option>
            {forms.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        )}
        {tr.event === 'order.status' && (
          <Select aria-label={t('auto.status')} value={tr.status ?? ''} onChange={(e) => setTrigger({ status: e.target.value || undefined })}>
            <option value="">{t('auto.anyStatus')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`orders.status.${s}` as MessageKey)}
              </option>
            ))}
          </Select>
        )}
        {tr.event !== 'form.submitted' && (
          <Input type="number" min={0} aria-label={t('auto.minTotal')} placeholder={t('auto.minTotal')} value={tr.minTotal !== undefined ? tr.minTotal / 100 : ''} onChange={(e) => setTrigger({ minTotal: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100) })} />
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">{t('auto.then')}</legend>
        {draft.actions.map((a, i) => (
          <div key={i} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Select aria-label={`${t('auto.then')} ${i + 1}`} value={a.type} onChange={(e) => setAction(i, blankAction(e.target.value as Action['type']))}>
                {(['email_contact', 'email_team', 'add_tag', 'telegram'] as const).map((x) => (
                  <option key={x} value={x}>
                    {t(`auto.action.${x}` as MessageKey)}
                  </option>
                ))}
              </Select>
              {draft.actions.length > 1 && (
                <button type="button" aria-label={t('auto.removeAction')} onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })} className="rounded p-1 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {a.type === 'add_tag' && <Input aria-label={t('auto.tag')} placeholder={t('auto.tag')} value={a.tag} maxLength={40} onChange={(e) => setAction(i, { ...a, tag: e.target.value })} />}
            {a.type === 'email_team' && <Input type="email" aria-label={t('auto.to')} placeholder={t('auto.to')} value={a.to} onChange={(e) => setAction(i, { ...a, to: e.target.value })} />}
            {a.type === 'telegram' && (
              <>
                <textarea aria-label={t('auto.tgText')} placeholder={t('auto.tgText')} rows={3} value={a.text} maxLength={3000} onChange={(e) => setAction(i, { ...a, text: e.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm" />
                <p className="text-[11px] text-muted-foreground">{t('auto.vars', { vars: VARS.join(' ') })}</p>
              </>
            )}
            {a.type !== 'add_tag' && a.type !== 'telegram' && (
              <>
                <Input aria-label={t('auto.subject')} placeholder={t('auto.subject')} value={a.subject} maxLength={200} onChange={(e) => setAction(i, { ...a, subject: e.target.value })} />
                <textarea aria-label={t('auto.body')} placeholder={t('auto.body')} rows={4} value={a.body} maxLength={5000} onChange={(e) => setAction(i, { ...a, body: e.target.value })} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm" />
                <p className="text-[11px] text-muted-foreground">{t('auto.vars', { vars: VARS.join(' ') })}</p>
              </>
            )}
          </div>
        ))}
        {draft.actions.length < 5 && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, actions: [...draft.actions, blankAction('add_tag')] })}>
            <Plus className="h-3.5 w-3.5" /> {t('auto.addAction')}
          </Button>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!valid} loading={saving}>
          {t('auto.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
          {t('auto.cancel')}
        </Button>
      </div>
    </form>
  );
}
