'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, ArrowRight, Info, RefreshCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, Input, Label, Select, Skeleton } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

type Severity = 'error' | 'warning' | 'info';
interface Issue {
  code: string;
  severity: Severity;
  blockId?: string;
  detail?: string;
}
interface Audit {
  score: number | null;
  totals: Record<Severity, number>;
  pages: { id: string; title: string; path: string; locale: string; published: boolean; score: number; words: number; issues: Issue[] }[];
  checkedAt: string;
}
interface Redirect {
  id: string;
  fromPath: string;
  toPath: string;
  statusCode: number;
  automatic: boolean;
  note: string | null;
}

const ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;
const TONE: Record<Severity, string> = { error: 'text-destructive', warning: 'text-warning', info: 'text-muted-foreground' };
const scoreTone = (s: number) => (s >= 90 ? 'text-success border-success/40' : s >= 70 ? 'text-warning border-warning/40' : 'text-destructive border-destructive/40');

/** Site → SEO: the audit of every page, and the redirects the renderer applies. */
export default function SeoPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const tab = params.get('tab') === 'redirects' ? 'redirects' : 'audit';
  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b" role="tablist">
        {(['audit', 'redirects'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => router.replace(`/sites/${siteId}/seo${id === 'redirects' ? '?tab=redirects' : ''}`)} className={cn('px-3 py-2 text-sm', tab === id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
            {t(`seo.tab.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'audit' ? <AuditView siteId={siteId} /> : <RedirectsView siteId={siteId} />}
    </div>
  );
}

function AuditView({ siteId }: { siteId: string }) {
  const t = useT();
  const tid = useTenantId();
  const audit = useQuery({ queryKey: ['seo-audit', tid, siteId], queryFn: () => api<Audit>(`/sites/${siteId}/seo/audit`), enabled: Boolean(tid) });
  if (audit.isPending) return <Skeleton className="h-40" />;
  if (!audit.data) return <p className="text-sm text-destructive">{errorMessage(audit.error)}</p>;
  const a = audit.data;
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-6 p-5">
        <div className={cn('grid h-20 w-20 place-items-center rounded-full border-4 text-2xl font-bold tabular-nums', a.score === null ? 'border-border text-muted-foreground' : scoreTone(a.score))} aria-label={t('seo.score')}>
          {a.score ?? '—'}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold">{t('seo.score')}</p>
          <p className="text-sm text-muted-foreground">{a.score === null ? t('seo.noPublished') : t('seo.scoreHint')}</p>
          <div className="flex flex-wrap gap-3 pt-1 text-sm">
            <span className="text-destructive">{t('seo.errors', { count: a.totals.error })}</span>
            <span className="text-warning">{t('seo.warnings', { count: a.totals.warning })}</span>
            <span className="text-muted-foreground">{t('seo.infos', { count: a.totals.info })}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" loading={audit.isFetching} onClick={() => void audit.refetch()}>
            <RefreshCw className="h-3.5 w-3.5" /> {t('seo.rerun')}
          </Button>
          <span className="text-[11px] text-muted-foreground">{t('seo.checked', { when: relativeTime(a.checkedAt) })}</span>
        </div>
      </Card>
      <ul className="space-y-2" aria-label={t('seo.tab.audit')}>
        {a.pages.map((p) => (
          <li key={p.id}>
            <Card className="p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold tabular-nums', scoreTone(p.score))}>{p.score}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {p.title}
                    {!p.published && <Badge className="border-border text-muted-foreground">{t('seo.draft')}</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.path} · {t('seo.words', { count: p.words })}
                  </p>
                </div>
                <Link href={`/sites/${siteId}/pages/${p.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  {t('seo.open')} <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
              {p.issues.length === 0 ? (
                <p className="mt-2 text-xs text-success">{t('seo.allGood')}</p>
              ) : (
                <ul className="mt-3 space-y-1">
                  {p.issues.map((i, k) => {
                    const Icon = ICON[i.severity];
                    const text = t(`seo.issue.${i.code}` as MessageKey, { detail: i.detail ?? '' });
                    return (
                      <li key={k} className="flex items-start gap-2 text-sm">
                        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE[i.severity])} aria-label={i.severity} />
                        {i.blockId ? (
                          <Link href={`/sites/${siteId}/pages/${p.id}?block=${encodeURIComponent(i.blockId)}`} className="hover:underline">
                            {text}
                          </Link>
                        ) : (
                          <span>{text}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RedirectsView({ siteId }: { siteId: string }) {
  const t = useT();
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Site');
  const key = ['redirects', tid, siteId];
  const list = useQuery({ queryKey: key, queryFn: () => api<Redirect[]>(`/sites/${siteId}/redirects`), enabled: Boolean(tid) });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('301');
  const [csv, setCsv] = useState('');
  const [importErrors, setImportErrors] = useState<{ line: number; message: string }[]>([]);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const add = useMutation({
    mutationFn: () => api<Redirect>(`/sites/${siteId}/redirects`, { body: { fromPath: from, toPath: to, statusCode: Number(status) } }),
    onSuccess: () => (toast.success(t('seo.redirects.added')), setFrom(''), setTo(''), void refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/redirects/${id}`, { method: 'DELETE' }),
    onSuccess: () => (toast.success(t('seo.redirects.deleted')), void refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const importCsv = useMutation({
    mutationFn: () => api<{ imported: number; errors: { line: number; message: string }[] }>(`/sites/${siteId}/redirects/import`, { body: { csv } }),
    onSuccess: (r) => (toast.success(t('seo.import.done', { count: r.imported })), setImportErrors(r.errors), r.errors.length || setCsv(''), void refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('seo.redirects.hint')}</p>
      {canEdit && (
        <Card className="p-4">
          <form
            className="grid gap-3 md:grid-cols-[1fr_1fr_12rem_auto] md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="rd-from">{t('seo.redirects.from')}</Label>
              <Input id="rd-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder={t('seo.redirects.fromPlaceholder')} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rd-to">{t('seo.redirects.to')}</Label>
              <Input id="rd-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('seo.redirects.toPlaceholder')} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rd-status">{t('seo.redirects.status')}</Label>
              <Select id="rd-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full">
                {['301', '302', '307', '308'].map((s) => (
                  <option key={s} value={s}>
                    {t(`seo.redirects.${s}` as MessageKey)}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" loading={add.isPending} disabled={!from.trim() || !to.trim()}>
              {t('seo.redirects.add')}
            </Button>
          </form>
        </Card>
      )}
      {list.isPending ? (
        <Skeleton className="h-24" />
      ) : !list.data?.length ? (
        <EmptyState icon={<ArrowRight />} title={t('seo.tab.redirects')} description={t('seo.redirects.empty')} />
      ) : (
        <Card className="divide-y">
          {list.data.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <code className="min-w-0 truncate font-mono text-xs">{r.fromPath}</code>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{r.toPath}</code>
              <Badge className="border-border text-muted-foreground">{r.statusCode}</Badge>
              {r.automatic && (
                <Badge className="border-accent/40 text-accent" title={t('seo.redirects.autoHint')}>
                  {t('seo.redirects.auto')}
                </Badge>
              )}
              {canEdit && (
                <button type="button" aria-label={t('seo.redirects.delete', { from: r.fromPath })} onClick={() => remove.mutate(r.id)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </Card>
      )}
      {canEdit && (
        <Card className="space-y-2 p-4">
          <p className="font-medium">{t('seo.import.title')}</p>
          <p className="text-xs text-muted-foreground">{t('seo.import.hint')}</p>
          <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label={t('seo.import.title')} placeholder={'from,to,status\n/old,/new,301'} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" />
          {importErrors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">
              {importErrors.map((e) => (
                <li key={e.line}>{t('seo.import.errors', { line: e.line, message: e.message })}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" loading={importCsv.isPending} disabled={!csv.trim()} onClick={() => importCsv.mutate()}>
              {t('seo.import.run')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
