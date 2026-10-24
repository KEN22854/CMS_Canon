'use client';

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Bot, Download, FileJson, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, download, errorMessage } from '@/lib/api';
import type { AuditItem } from '@/lib/platform';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

interface Filters {
  action: string;
  entityType: string;
  actorType: string;
  aiInvolved: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { action: '', entityType: '', actorType: '', aiInvolved: '', from: '', to: '' };
const ENTITY_TYPES = ['Page', 'Entry', 'Site', 'Collection', 'Media', 'Fact', 'Branch', 'Member', 'ApiKey', 'Webhook', 'Plugin', 'SsoConnection', 'Tenant', 'Billing', 'User', 'AuditLog'];

const qs = (f: Filters, extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();

export default function AuditPage() {
  const tid = useTenantId();
  const ability = useAbility();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const log = useInfiniteQuery({
    queryKey: ['audit', tid, filters],
    queryFn: ({ pageParam }) => api<{ items: AuditItem[]; nextCursor: string | null }>(`/audit?${qs(filters, { limit: '50', ...(pageParam ? { cursor: pageParam } : {}) })}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(tid),
  });
  const items = useMemo(() => log.data?.pages.flatMap((p) => p.items) ?? [], [log.data]);
  const integrity = useMutation({
    mutationFn: () => api<{ ok: boolean; sealedDays: number; days: { day: string; count: number; status: 'ok' | 'modified' | 'broken_chain' }[] }>('/audit/integrity'),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const exportAs = async (format: 'csv' | 'jsonl') => {
    try {
      await download(`/audit/export?${qs(filters, { format })}`, `audit.${format}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change in this workspace — who, what, when, from where, and whether AI was involved. Append-only and sealed daily with a hash chain."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void exportAs('csv')}>
              <Download className="h-4 w-4" /> CSV
            </Button>
            <Button variant="outline" onClick={() => void exportAs('jsonl')}>
              <Download className="h-4 w-4" /> JSON Lines
            </Button>
          </div>
        }
      />
      <div className="space-y-6">
        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1">
              <Label htmlFor="f-action">Action starts with</Label>
              <Input id="f-action" placeholder="page." value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-entity">Entity</Label>
              <Select id="f-entity" value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}>
                <option value="">Any</option>
                {ENTITY_TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-actor">Actor</Label>
              <Select id="f-actor" value={draft.actorType} onChange={(e) => setDraft({ ...draft, actorType: e.target.value })}>
                <option value="">Anyone</option>
                <option value="user">People</option>
                <option value="api-key">API keys</option>
                <option value="agent">AI agents</option>
                <option value="system">System</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-from">From</Label>
              <Input id="f-from" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="f-to">To</Label>
              <Input id="f-to" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </div>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.aiInvolved === 'true'} onChange={(e) => setDraft({ ...draft, aiInvolved: e.target.checked ? 'true' : '' })} /> AI involved only
              </label>
              <Button size="sm" onClick={() => setFilters(draft)}>
                Apply
              </Button>
            </div>
          </CardContent>
        </Card>

        {log.isError && <Alert tone="error">{errorMessage(log.error)}</Alert>}
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Who</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Entity</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                  <th className="px-4 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground" title={new Date(r.createdAt).toLocaleString()}>
                      {relativeTime(r.createdAt)}
                    </td>
                    <td className="px-4 py-2">
                      {r.user ? <span title={r.user.email}>{r.user.name}</span> : <span className="text-muted-foreground">{r.actorType}</span>}
                      {r.aiInvolved && <Bot className="ml-1 inline h-3.5 w-3.5 text-primary" aria-label="AI involved" />}
                    </td>
                    <td className="px-4 py-2">
                      <code className="text-xs">{r.action}</code>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {r.entityType}
                      <br />
                      <span className="font-mono">{r.entityId.slice(0, 12)}</span>
                    </td>
                    <td className="max-w-md px-4 py-2">
                      <code className="line-clamp-2 break-all text-[11px] text-muted-foreground">{JSON.stringify(r.changes) === '{}' ? '' : JSON.stringify(r.changes)}</code>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.ipAddress ?? ''}</td>
                  </tr>
                ))}
                {!log.isPending && items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      Nothing matches these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
        {log.hasNextPage && (
          <div className="text-center">
            <Button variant="outline" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> Integrity
              </CardTitle>
              <CardDescription>Each finished day is sealed with SHA-256 over its rows, chained to the day before. Verification recomputes the chain: an edited, inserted or deleted entry breaks its day.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" loading={integrity.isPending} onClick={() => integrity.mutate()}>
                Verify the chain
              </Button>
              {integrity.data &&
                (integrity.data.ok ? (
                  <Alert>
                    <ShieldCheck className="mr-1 inline h-4 w-4 text-success" /> Intact — {integrity.data.sealedDays} sealed day{integrity.data.sealedDays === 1 ? '' : 's'} verified{integrity.data.sealedDays === 0 ? ' (today is sealed after midnight UTC)' : ''}.
                  </Alert>
                ) : (
                  <Alert tone="error">
                    <ShieldAlert className="mr-1 inline h-4 w-4" /> Tampering detected on{' '}
                    {integrity.data.days
                      .filter((d) => d.status !== 'ok')
                      .map((d) => `${d.day} (${d.status.replace('_', ' ')})`)
                      .join(', ')}
                    .
                  </Alert>
                ))}
            </CardContent>
          </Card>
          {ability.can('delete', 'Tenant') && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileJson className="h-4 w-4 text-primary" aria-hidden /> Workspace export
                </CardTitle>
                <CardDescription>Everything in this workspace — sites, pages, collections, entries, Canon facts with history, media metadata, segments, experiments and settings — as one JSON file (data portability).</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" onClick={() => void download('/workspace/export', 'canon-workspace.json').catch((err) => toast.error(errorMessage(err)))}>
                  <Download className="h-4 w-4" /> Export workspace
                </Button>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <Badge>owner only</Badge> The export is recorded in this log.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
