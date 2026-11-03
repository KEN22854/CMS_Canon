'use client';

import { FORM_FIELD_TYPES, formFieldsSchema, type FormField } from '@canon/fields';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Download,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, download, errorMessage } from '@/lib/api';
import {
  FIELD_TYPE_LABEL,
  useForm,
  type SiteForm,
  type Submission,
  type SubmissionStatus,
} from '@/lib/forms';
import { useTenantId } from '@/lib/queries';
import { useT, type MessageKey } from '@/lib/i18n';
import { cn, relativeTime } from '@/lib/utils';

type Tab = 'submissions' | 'fields' | 'settings';

export default function FormPage() {
  return (
    <Suspense>
      <FormScreen />
    </Suspense>
  );
}

function FormScreen() {
  const { siteId, formId } = useParams<{ siteId: string; formId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const form = useForm(formId);
  const tab = (params.get('tab') as Tab) ?? 'submissions';
  const t = useT();
  if (form.isPending)
    return (
      <Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
    );
  if (form.isError || !form.data) return <Alert tone="error">{errorMessage(form.error)}</Alert>;
  const f = form.data;
  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/sites/${siteId}/forms`}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> {t('forms.back')}
        </Link>
        <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
          {f.name} {!f.isActive && <Badge>{t('forms.inactive')}</Badge>}
        </h2>
      </div>
      <div className="flex gap-1 border-b" role="tablist">
        {(['submissions', 'fields', 'settings'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => router.replace(`/sites/${siteId}/forms/${formId}?tab=${k}`)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === k
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`forms.tab.${k}` as MessageKey)}
          </button>
        ))}
      </div>
      {tab === 'submissions' && <Submissions form={f} />}
      {tab === 'fields' && <FieldsEditor form={f} />}
      {tab === 'settings' && <SettingsEditor form={f} />}
    </div>
  );
}

// ── Submissions ───────────────────────────────────────────────────────────────

const STATUS_TONE: Record<SubmissionStatus, string> = {
  NEW: 'border-primary/40 text-primary',
  READ: '',
  ARCHIVED: 'text-muted-foreground',
  SPAM: 'border-destructive/40 text-destructive',
};

function Submissions({ form }: { form: SiteForm }) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const [status, setStatus] = useState<'' | SubmissionStatus>('');
  const [open, setOpen] = useState<string | null>(null);
  const t = useT();
  const list = useInfiniteQuery({
    queryKey: ['submissions', tid, form.id, status],
    queryFn: ({ pageParam }) =>
      api<{
        items: Submission[];
        nextCursor: string | null;
        counts: Partial<Record<SubmissionStatus, number>>;
      }>(
        `/forms/${form.id}/submissions?${new URLSearchParams({ ...(status ? { status } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(tid),
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const counts = list.data?.pages[0]?.counts ?? {};
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['submissions', tid, form.id] });
    void qc.invalidateQueries({ queryKey: ['forms', tid, form.siteId] });
  };
  const act = useMutation({
    mutationFn: ({ id, op }: { id: string; op: SubmissionStatus | 'delete' }) =>
      op === 'delete'
        ? api(`/form-submissions/${id}`, { method: 'DELETE' })
        : api(`/form-submissions/${id}`, { method: 'PATCH', body: { status: op } }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });
  const columns = form.fields.filter((f) => f.type !== 'hidden' && f.type !== 'consent').slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex gap-1 rounded-md border p-0.5 text-sm"
          role="radiogroup"
          aria-label={t('forms.status')}
        >
          {(
            [
              ['', 'forms.inbox'],
              ['NEW', 'forms.status.NEW'],
              ['READ', 'forms.status.READ'],
              ['ARCHIVED', 'forms.status.ARCHIVED'],
              ['SPAM', 'forms.status.SPAM'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={status === v}
              onClick={() => setStatus(v)}
              className={cn(
                'rounded px-2.5 py-1',
                status === v ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(label)}
              {v && counts[v] ? <span className="ml-1 text-xs opacity-70">{counts[v]}</span> : null}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void download(`/forms/${form.id}/submissions/export`, `${form.slug}.csv`).catch((err) =>
              toast.error(errorMessage(err)),
            )
          }
        >
          <Download className="h-4 w-4" /> {t('forms.exportCsv')}
        </Button>
      </div>
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('forms.received')}</th>
                {columns.map((c) => (
                  <th key={c.name} className="px-4 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="px-4 py-2 font-medium">{t('forms.status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <SubmissionRow
                  key={s.id}
                  s={s}
                  form={form}
                  columns={columns}
                  open={open === s.id}
                  onToggle={() => {
                    setOpen(open === s.id ? null : s.id);
                    if (s.status === 'NEW' && ability.can('update', 'Form'))
                      act.mutate({ id: s.id, op: 'READ' });
                  }}
                  onAct={(op) => act.mutate({ id: s.id, op })}
                  canEdit={ability.can('update', 'Form')}
                />
              ))}
              {!list.isPending && items.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 2} className="px-4 py-10 text-center text-muted-foreground">
                    {status === 'SPAM' ? t('forms.noSpam') : t('forms.noSubmissions')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {list.hasNextPage && (
        <div className="text-center">
          <Button
            variant="outline"
            loading={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('common.loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

function SubmissionRow({
  s,
  form,
  columns,
  open,
  onToggle,
  onAct,
  canEdit,
}: {
  s: Submission;
  form: SiteForm;
  columns: FormField[];
  open: boolean;
  onToggle: () => void;
  onAct: (op: SubmissionStatus | 'delete') => void;
  canEdit: boolean;
}) {
  const t = useT();
  const value = (v: unknown) =>
    Array.isArray(v)
      ? v.join(', ')
      : v === true
        ? 'yes'
        : v === false
          ? 'no'
          : v === undefined
            ? '—'
            : String(v);
  return (
    <>
      <tr
        className={cn(
          'cursor-pointer border-b last:border-0 hover:bg-muted/40',
          s.status === 'NEW' && 'font-medium',
        )}
        onClick={onToggle}
      >
        <td
          className="whitespace-nowrap px-4 py-2 text-muted-foreground"
          title={new Date(s.createdAt).toLocaleString()}
        >
          {relativeTime(s.createdAt)}
        </td>
        {columns.map((c) => (
          <td key={c.name} className="max-w-[12rem] truncate px-4 py-2">
            {value(s.data[c.name])}
          </td>
        ))}
        <td className="px-4 py-2">
          <Badge className={STATUS_TONE[s.status]}>{t(`forms.status.${s.status}`)}</Badge>
          {s.aiClassification?.category && s.aiClassification.category !== 'spam' && (
            <Badge className="ml-1">{s.aiClassification.category}</Badge>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/20">
          <td colSpan={columns.length + 2} className="space-y-3 px-4 py-4">
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {form.fields.map((f) => (
                <div key={f.name}>
                  <dt className="text-xs text-muted-foreground">{f.label}</dt>
                  <dd className="whitespace-pre-wrap break-words">{value(s.data[f.name])}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {s.meta.path && <>Page {s.meta.path} · </>}
              {s.meta.utm?.source && <>source {s.meta.utm.source} · </>}
              {s.meta.country && <>{s.meta.country} · </>}
              {s.ipAddress && <>network {s.ipAddress}</>}
            </p>
            {s.aiClassification?.summary && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Bot className="h-3.5 w-3.5" aria-hidden /> {s.aiClassification.summary}
              </p>
            )}
            {s.status === 'SPAM' && (s.meta.spamReasons?.length ?? 0) > 0 && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> {s.meta.spamReasons!.join(', ')}
              </p>
            )}
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {s.status !== 'ARCHIVED' && (
                  <Button size="sm" variant="outline" onClick={() => onAct('ARCHIVED')}>
                    {t('forms.archive')}
                  </Button>
                )}
                {s.status === 'SPAM' ? (
                  <Button size="sm" variant="outline" onClick={() => onAct('READ')}>
                    {t('forms.notSpam')}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onAct('SPAM')}>
                    {t('forms.markSpam')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => window.confirm(t('forms.eraseConfirm')) && onAct('delete')}
                >
                  <Trash2 className="h-4 w-4" /> {t('forms.erase')}
                </Button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Fields ────────────────────────────────────────────────────────────────────

const nameFrom = (label: string, taken: string[]) => {
  const base =
    label
      .normalize('NFKD')
      .replace(/[^\w\s]/g, '')
      .trim()
      .split(/\s+/)
      .map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
      .join('')
      .replace(/^[^a-z]+/, '')
      .slice(0, 30) || 'field';
  let n = base;
  for (let i = 2; taken.includes(n); i++) n = `${base}${i}`;
  return n;
};

function FieldsEditor({ form }: { form: SiteForm }) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Form');
  const t = useT();
  const [fields, setFields] = useState<FormField[]>(form.fields);
  useEffect(() => setFields(form.fields), [form.fields]);
  const parsed = formFieldsSchema.safeParse(fields);
  const save = useMutation({
    mutationFn: () => api<SiteForm>(`/forms/${form.id}`, { method: 'PATCH', body: { fields } }),
    onSuccess: (f) => (qc.setQueryData(['form', tid, form.id], f), toast.success(t('forms.fieldsSaved'))),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const set = (i: number, patch: Partial<FormField>) =>
    setFields(fields.map((f, j) => (j === i ? ({ ...f, ...patch } as FormField) : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setFields(next);
  };

  return (
    <div className="space-y-3">
      {fields.map((f, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 p-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_8rem]">
            <div className="flex items-center justify-between gap-2 md:col-span-2 lg:col-span-3">
              <span className="text-[11px] text-muted-foreground">
                #{i + 1} · key <code>{f.name}</code>
              </span>
              <div className="flex items-center gap-1">
                <label className="mr-2 flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={f.required}
                    disabled={!canEdit || f.type === 'consent'}
                    onChange={(e) => set(i, { required: e.target.checked })}
                  />{' '}
                  required
                </label>
                {canEdit && (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Move up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Move down"
                      disabled={i === fields.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${f.label}`}
                      onClick={() => setFields(fields.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`fl-${i}`}>Label</Label>
              <Input
                id={`fl-${i}`}
                value={f.label}
                disabled={!canEdit}
                onChange={(e) => set(i, { label: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`ft-${i}`}>Type</Label>
              <Select
                id={`ft-${i}`}
                value={f.type}
                disabled={!canEdit}
                onChange={(e) =>
                  set(i, {
                    type: e.target.value as FormField['type'],
                    ...(e.target.value === 'consent' ? { required: true } : {}),
                  })
                }
              >
                {FORM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`fw-${i}`}>Width</Label>
              <Select
                id={`fw-${i}`}
                value={f.width ?? 'full'}
                disabled={!canEdit}
                onChange={(e) => set(i, { width: e.target.value as 'full' | 'half' })}
              >
                <option value="full">full</option>
                <option value="half">half</option>
              </Select>
            </div>
            {(f.type === 'select' || f.type === 'multiselect') && (
              <div className="space-y-1 md:col-span-2 lg:col-span-3">
                <Label htmlFor={`fo-${i}`}>Choices (one per line)</Label>
                <textarea
                  id={`fo-${i}`}
                  rows={3}
                  disabled={!canEdit}
                  value={(f.options ?? []).join('\n')}
                  onChange={(e) =>
                    set(i, {
                      options: e.target.value
                        .split('\n')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                  className="w-full rounded-md border border-input bg-background p-2 text-sm"
                />
              </div>
            )}
            {f.type === 'hidden' ? (
              <div className="space-y-1 md:col-span-2 lg:col-span-3">
                <Label htmlFor={`fd-${i}`}>Value sent with every submission</Label>
                <Input
                  id={`fd-${i}`}
                  value={f.defaultValue ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => set(i, { defaultValue: e.target.value })}
                />
              </div>
            ) : (
              <div className="grid gap-3 md:col-span-2 lg:col-span-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`fp-${i}`}>Placeholder</Label>
                  <Input
                    id={`fp-${i}`}
                    value={f.placeholder ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => set(i, { placeholder: e.target.value || undefined })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`fh-${i}`}>Help text</Label>
                  <Input
                    id={`fh-${i}`}
                    value={f.help ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => set(i, { help: e.target.value || undefined })}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {!parsed.success && (
        <Alert tone="error">
          {parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join(' · ')}
        </Alert>
      )}
      {canEdit && (
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="outline"
            disabled={fields.length >= 30}
            onClick={() =>
              setFields([
                ...fields,
                {
                  name: nameFrom(
                    'New field',
                    fields.map((f) => f.name),
                  ),
                  type: 'text',
                  label: 'New field',
                  required: false,
                  width: 'full',
                },
              ])
            }
          >
            <Plus className="h-4 w-4" /> {t('forms.addField')}
          </Button>
          <Button disabled={!parsed.success} loading={save.isPending} onClick={() => save.mutate()}>
            {t('forms.saveFields')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────

function SettingsEditor({ form }: { form: SiteForm }) {
  const tid = useTenantId();
  const qc = useQueryClient();
  const router = useRouter();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Form');
  const t = useT();
  const [s, setS] = useState({
    name: form.name,
    successMessage: form.successMessage ?? '',
    redirectUrl: form.redirectUrl ?? '',
    emails: form.notificationEmails.join(', '),
    privacyNote: form.settings.privacyNote ?? '',
    notifyMembers: form.settings.notifyMembers !== false,
    spamDetection: form.aiSettings.spamDetection !== false,
    isActive: form.isActive,
  });
  const save = useMutation({
    mutationFn: () =>
      api<SiteForm>(`/forms/${form.id}`, {
        method: 'PATCH',
        body: {
          name: s.name,
          successMessage: s.successMessage || null,
          redirectUrl: s.redirectUrl || null,
          notificationEmails: s.emails.split(/[\s,;]+/).filter(Boolean),
          settings: { privacyNote: s.privacyNote || undefined, notifyMembers: s.notifyMembers },
          aiSettings: { spamDetection: s.spamDetection },
          isActive: s.isActive,
        },
      }),
    onSuccess: (f) => (qc.setQueryData(['form', tid, form.id], f), toast.success(t('forms.settingsSaved'))),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/forms/${form.id}`, { method: 'DELETE' }),
    onSuccess: () => (
      void qc.invalidateQueries({ queryKey: ['forms', tid, form.siteId] }),
      router.push(`/sites/${form.siteId}/forms`)
    ),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Behaviour</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="fs-name">Name</Label>
            <Input
              id="fs-name"
              value={s.name}
              disabled={!canEdit}
              onChange={(e) => setS({ ...s, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fs-emails">E-mail every submission to</Label>
            <Input
              id="fs-emails"
              value={s.emails}
              disabled={!canEdit}
              placeholder="sales@company.com, crm@company.com"
              onChange={(e) => setS({ ...s, emails: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fs-success">Success message</Label>
            <Input
              id="fs-success"
              value={s.successMessage}
              disabled={!canEdit}
              onChange={(e) => setS({ ...s, successMessage: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fs-redirect">Or redirect to</Label>
            <Input
              id="fs-redirect"
              value={s.redirectUrl}
              disabled={!canEdit}
              placeholder="/thank-you"
              onChange={(e) => setS({ ...s, redirectUrl: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="fs-privacy">Privacy note under the button</Label>
          <Input
            id="fs-privacy"
            value={s.privacyNote}
            disabled={!canEdit}
            placeholder="We use your data only to answer your request."
            onChange={(e) => setS({ ...s, privacyNote: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.notifyMembers}
              disabled={!canEdit}
              onChange={(e) => setS({ ...s, notifyMembers: e.target.checked })}
            />{' '}
            Notify editors in Canon
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.spamDetection}
              disabled={!canEdit}
              onChange={(e) => setS({ ...s, spamDetection: e.target.checked })}
            />{' '}
            AI spam screening for doubtful submissions
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.isActive}
              disabled={!canEdit}
              onChange={(e) => setS({ ...s, isActive: e.target.checked })}
            />{' '}
            Accepting submissions
          </label>
        </div>
        {canEdit && (
          <div className="flex justify-between gap-2 border-t pt-4">
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => window.confirm(t('forms.deleteConfirm', { name: form.name })) && remove.mutate()}
            >
              {t('forms.deleteForm')}
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              {t('forms.saveSettings')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
