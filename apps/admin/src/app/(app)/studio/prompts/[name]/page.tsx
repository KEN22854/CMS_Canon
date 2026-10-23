'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Play, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd, relativeTime } from '@/lib/utils';

interface Version {
  id: string;
  version: number;
  scope: 'tenant' | 'global';
  isActive: boolean;
  system: string;
  template: string;
  variables: string[];
  modelKey: string | null;
  createdBy: string | null;
  createdAt: string;
  stats: { generations: number; avgLatencyMs: number; costUsd: number };
}

interface Detail {
  name: string;
  feature: string;
  activeId: string | null;
  versions: Version[];
  runs: { id: string; promptId: string; input: { variables?: Record<string, string> }; output: { text?: string }; tokens: number; costUsd: number; latencyMs: number; createdAt: string }[];
}

export default function PromptPage() {
  const { name: raw } = useParams<{ name: string }>();
  const name = decodeURIComponent(raw);
  const tid = useTenantId();
  const q = useQuery({ queryKey: ['studio-prompt', tid, name], queryFn: () => api<Detail>(`/ai/studio/prompts/${encodeURIComponent(name)}`), enabled: Boolean(tid) });
  if (q.isPending) return <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!q.data) return <Alert tone="error">{errorMessage(q.error)}</Alert>;
  return <PromptView key={q.data.activeId ?? 'none'} d={q.data} />;
}

function PromptView({ d }: { d: Detail }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const ability = useAbility();
  const active = d.versions.find((v) => v.id === d.activeId) ?? d.versions[0]!;
  const [selected, setSelected] = useState(active.id);
  const shown = d.versions.find((v) => v.id === selected) ?? active;
  const [system, setSystem] = useState(active.system);
  const [template, setTemplate] = useState(active.template);
  const [modelKey, setModelKey] = useState(active.modelKey ?? '');
  const vars = useMemo(() => [...new Set([...`${shown.system}\n${shown.template}`.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))], [shown]);
  const [values, setValues] = useState<Record<string, string>>({});
  const canManage = ability.can('manage', 'Ai');
  const refresh = () => (void qc.invalidateQueries({ queryKey: ['studio-prompt', tid, d.name] }), void qc.invalidateQueries({ queryKey: ['studio-prompts', tid] }));

  const create = useMutation({
    mutationFn: () => api<{ version: number }>(`/ai/studio/prompts/${encodeURIComponent(d.name)}/versions`, { body: { system, template, modelKey: modelKey || null } }),
    onSuccess: (r) => (toast.success(`v${r.version} is now active`), refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const activate = useMutation({
    mutationFn: (v: Version) => api(`/ai/studio/prompts/${encodeURIComponent(d.name)}/activate`, { body: { version: v.version, scope: v.scope } }),
    onSuccess: () => (toast.success('Activated'), refresh()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const test = useMutation({
    mutationFn: () => api<{ output: string; latencyMs: number; costUsd: number; model: string; unresolvedVariables: string[]; rendered: { system: string; user: string } }>(`/ai/studio/prompts/${encodeURIComponent(d.name)}/test`, { body: { variables: values, version: shown.version, scope: shown.scope } }),
    onSuccess: () => refresh(),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const dirty = system !== active.system || template !== active.template || modelKey !== (active.modelKey ?? '');

  return (
    <div className="space-y-6">
      <div>
        <Link href="/studio?tab=prompts" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="h-3 w-3" /> Prompts
        </Link>
        <h1 className="font-mono text-xl font-semibold">{d.name}</h1>
        <p className="text-sm text-muted-foreground">Feature {d.feature.toLowerCase().replace('_', ' ')} · active v{active.version} ({active.scope === 'tenant' ? 'your version' : 'platform default'})</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <ul className="space-y-1">
          {d.versions.map((v) => (
            <li key={v.id}>
              <button type="button" onClick={() => setSelected(v.id)} className={cn('w-full rounded-md border px-3 py-2 text-left text-sm', selected === v.id ? 'border-primary bg-primary/5' : 'hover:bg-muted')}>
                <span className="font-medium">v{v.version}</span> <Badge className={v.scope === 'tenant' ? 'border-primary/40 text-primary' : ''}>{v.scope === 'tenant' ? 'yours' : 'platform'}</Badge> {v.id === d.activeId && <Badge className="border-success/40 text-success">active</Badge>}
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {v.stats.generations} calls · {v.stats.avgLatencyMs} ms avg · {formatUsd(v.stats.costUsd)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>
                v{shown.version} {shown.scope === 'global' ? '(platform, read-only)' : ''}
              </CardTitle>
              {canManage && shown.id !== d.activeId && (
                <Button size="sm" variant="outline" loading={activate.isPending} onClick={() => activate.mutate(shown)}>
                  <RotateCcw className="h-3.5 w-3.5" /> Activate this version
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">System</p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{shown.system || '—'}</pre>
              <p className="text-xs font-medium text-muted-foreground">Template</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs">{shown.template}</pre>
              <p className="text-[11px] text-muted-foreground">
                Model {shown.modelKey ?? 'tenant default'} · variables: {(shown.variables ?? []).join(', ') || '—'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test v{shown.version}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {vars.map((v) => (
                  <div key={v} className="space-y-1">
                    <Label htmlFor={`var-${v}`} className="font-mono text-xs">
                      {v}
                    </Label>
                    <Input id={`var-${v}`} value={values[v] ?? ''} onChange={(e) => setValues({ ...values, [v]: e.target.value })} />
                  </div>
                ))}
              </div>
              <Button loading={test.isPending} disabled={!ability.can('invoke', 'Ai')} onClick={() => test.mutate()}>
                <Play className="h-4 w-4" /> Run
              </Button>
              {test.data && (
                <div className="space-y-1">
                  {test.data.unresolvedVariables.length > 0 && <Alert>Unfilled variables: {test.data.unresolvedVariables.join(', ')}</Alert>}
                  <pre className="whitespace-pre-wrap rounded border p-2 text-sm">{test.data.output}</pre>
                  <p className="text-[11px] text-muted-foreground">
                    {test.data.model} · {test.data.latencyMs} ms · {formatUsd(test.data.costUsd)}
                  </p>
                </div>
              )}
              {d.runs.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Previous test runs ({d.runs.length})</summary>
                  <ul className="mt-2 space-y-1">
                    {d.runs.map((r) => (
                      <li key={r.id} className="rounded border p-2">
                        <span className="text-muted-foreground">
                          v{d.versions.find((v) => v.id === r.promptId)?.version} · {relativeTime(r.createdAt)} · {r.latencyMs} ms · {formatUsd(r.costUsd)}
                        </span>
                        <p className="line-clamp-2">{r.output.text}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>

          {canManage && (
            <Card>
              <CardHeader>
                <CardTitle>New version</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="p-system">System</Label>
                  <textarea id="p-system" rows={8} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={system} onChange={(e) => setSystem(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-template">Template</Label>
                  <textarea id="p-template" rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={template} onChange={(e) => setTemplate(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="p-model">Model</Label>
                  <Input id="p-model" className="font-mono text-xs" value={modelKey} onChange={(e) => setModelKey(e.target.value)} placeholder="anthropic/claude-haiku-5-5" />
                </div>
                <p className="text-[11px] text-muted-foreground">Saving creates v{Math.max(...d.versions.map((v) => v.version)) + 1} and makes it active for your workspace. Older versions stay available for rollback.</p>
                <Button loading={create.isPending} disabled={!dirty || !template.trim()} onClick={() => create.mutate()}>
                  Save as new version
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
