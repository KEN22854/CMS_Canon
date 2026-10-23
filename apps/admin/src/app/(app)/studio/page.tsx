'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, FlaskConical, MessageSquareCode, Play, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, Badge, Button, Card, CardContent, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import type { AgentRun } from '@/lib/canon';
import { useSites } from '@/lib/content';
import { useTenantId } from '@/lib/queries';
import { cn, formatUsd } from '@/lib/utils';

type Tab = 'prompts' | 'agents' | 'playground';
const TOOLS = ['canon.get_fact', 'canon.search_claims', 'canon.impact_analysis', 'content.search', 'content.read'] as const;

interface PromptRow {
  name: string;
  feature: string;
  active: { version: number; scope: 'tenant' | 'global'; modelKey: string | null } | null;
  versions: number;
  overridden: boolean;
  generations: number;
  costUsd: number;
}

interface Agent {
  id: string;
  name: string;
  type: string;
  systemPrompt: string;
  tools: string[];
  isActive: boolean;
  team: string | null;
  modelKey: string | null;
  runs: number;
}

export default function StudioPage() {
  return (
    <Suspense>
      <Studio />
    </Suspense>
  );
}

function Studio() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = (params.get('tab') as Tab) || 'prompts';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bot className="h-6 w-6 text-primary" /> AI Studio
        </h1>
        <p className="text-sm text-muted-foreground">Versioned prompts behind every AI feature, your own agents, and a playground to compare models on cost and quality.</p>
      </div>
      <nav className="flex gap-1 border-b" aria-label="AI Studio">
        {(
          [
            ['prompts', 'Prompts', MessageSquareCode],
            ['agents', 'Agents', Bot],
            ['playground', 'Playground', FlaskConical],
          ] as const
        ).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => router.replace(`/studio?tab=${id}`)} className={cn('-mb-px flex items-center gap-1 border-b-2 px-3 py-2 text-sm', tab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </nav>
      {tab === 'prompts' && <PromptsTab />}
      {tab === 'agents' && <AgentsTab />}
      {tab === 'playground' && <PlaygroundTab />}
    </div>
  );
}

function PromptsTab() {
  const tid = useTenantId();
  const prompts = useQuery({ queryKey: ['studio-prompts', tid], queryFn: () => api<PromptRow[]>('/ai/studio/prompts'), enabled: Boolean(tid) });
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Prompt</th>
            <th className="px-3 py-2 font-medium">Active</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Usage</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {prompts.data?.map((p) => (
            <tr key={p.name} className="hover:bg-muted/30">
              <td className="px-3 py-2">
                <Link href={`/studio/prompts/${encodeURIComponent(p.name)}`} className="font-mono text-xs font-medium hover:text-primary hover:underline">
                  {p.name}
                </Link>
                <p className="text-[11px] text-muted-foreground">{p.feature.toLowerCase().replace('_', ' ')}</p>
              </td>
              <td className="px-3 py-2">
                {p.active ? (
                  <Badge className={p.active.scope === 'tenant' ? 'border-primary/40 text-primary' : ''}>
                    v{p.active.version} · {p.active.scope === 'tenant' ? 'yours' : 'platform'}
                  </Badge>
                ) : (
                  '—'
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{p.active?.modelKey ?? 'tenant default'}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {p.generations} calls · {formatUsd(p.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {prompts.isError && <Alert tone="error">{errorMessage(prompts.error)}</Alert>}
    </div>
  );
}

function AgentsTab() {
  const tid = useTenantId();
  const qc = useQueryClient();
  const ability = useAbility();
  const sites = useSites();
  const agents = useQuery({ queryKey: ['studio-agents', tid], queryFn: () => api<Agent[]>('/ai/studio/agents'), enabled: Boolean(tid) });
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);
  const [running, setRunning] = useState<Agent | null>(null);
  const save = useMutation({
    mutationFn: (a: Partial<Agent>) => (a.id ? api<Agent>(`/ai/studio/agents/${a.id}`, { method: 'PATCH', body: { name: a.name, systemPrompt: a.systemPrompt, tools: a.tools, modelKey: a.modelKey || null } }) : api<Agent>('/ai/studio/agents', { body: { name: a.name, systemPrompt: a.systemPrompt, tools: a.tools ?? [], modelKey: a.modelKey || null } })),
    onSuccess: () => (setEditing(null), toast.success('Agent saved'), void qc.invalidateQueries({ queryKey: ['studio-agents', tid] })),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {ability.can('manage', 'Ai') && (
          <Button onClick={() => setEditing({ name: '', systemPrompt: '', tools: ['canon.get_fact', 'content.search'] })}>
            <Plus className="h-4 w-4" /> New agent
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {agents.data?.map((a) => (
          <Card key={a.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{a.name}</p>
                <span className="flex gap-1">
                  {a.team && <Badge className="border-primary/40 text-primary">Canon team</Badge>}
                  <Badge>{a.type.toLowerCase().replace('_', ' ')}</Badge>
                </span>
              </div>
              <p className="line-clamp-3 text-xs text-muted-foreground">{a.systemPrompt}</p>
              <div className="flex flex-wrap gap-1">
                {a.tools.map((t) => (
                  <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {t}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {a.modelKey ?? 'prompt default model'} · {a.runs} runs
                </span>
                <span className="flex gap-1">
                  {ability.can('manage', 'Ai') && (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                  )}
                  {a.type === 'CUSTOM' && ability.can('invoke', 'Ai') && (
                    <Button size="sm" variant="outline" onClick={() => setRunning(a)}>
                      <Play className="h-3.5 w-3.5" /> Run
                    </Button>
                  )}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {agents.data?.length === 0 && <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">No agents yet. The Canon team (Strategist, Copywriter, Translator, Fact-Checker) appears after the first propagation.</p>}

      {editing && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="font-medium">{editing.id ? `Edit ${editing.name}` : 'New agent'}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ag-name">Name</Label>
                <Input id="ag-name" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-model">Model (provider/name, optional)</Label>
                <Input id="ag-model" className="font-mono text-xs" placeholder="anthropic/claude-sonnet-5-5" value={editing.modelKey ?? ''} onChange={(e) => setEditing({ ...editing, modelKey: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ag-sys">System prompt</Label>
              <textarea id="ag-sys" rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editing.systemPrompt ?? ''} onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Tools (read-only)</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {TOOLS.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 font-mono text-xs">
                    <input type="checkbox" checked={editing.tools?.includes(t) ?? false} onChange={(e) => setEditing({ ...editing, tools: e.target.checked ? [...(editing.tools ?? []), t] : (editing.tools ?? []).filter((x) => x !== t) })} /> {t}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button loading={save.isPending} disabled={!editing.name?.trim() || (editing.systemPrompt?.trim().length ?? 0) < 10} onClick={() => save.mutate(editing)}>
                Save
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {running && <RunAgent agent={running} sites={sites.data ?? []} onClose={() => setRunning(null)} />}
    </div>
  );
}

function RunAgent({ agent, sites, onClose }: { agent: Agent; sites: { id: string; name: string }[]; onClose: () => void }) {
  const [input, setInput] = useState('');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const run = useMutation({ mutationFn: () => api<AgentRun>(`/ai/studio/agents/${agent.id}/run`, { body: { input, siteId } }), onError: (err) => toast.error(errorMessage(err)) });
  const result = run.data?.result as { final?: string; error?: string } | undefined;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <p className="font-medium">Run {agent.name}</p>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex gap-2">
          <Select aria-label="Site" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Input aria-label="Task" placeholder="e.g. Which pages mention the Pro price, and is it consistent?" value={input} onChange={(e) => setInput(e.target.value)} />
          <Button loading={run.isPending} disabled={!input.trim() || !siteId} onClick={() => run.mutate()}>
            <Play className="h-4 w-4" /> Run
          </Button>
        </div>
        {run.data && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {run.data.status.toLowerCase()} · {run.data.steps.length} steps · {run.data.totalTokens} tokens · {formatUsd(Number(run.data.costUsd))}
            </p>
            <ol className="space-y-1 border-l pl-3 text-xs">
              {run.data.steps.map((s) => (
                <li key={s.id}>
                  <span className="font-mono text-muted-foreground">#{s.stepNumber}</span> {s.node} {s.toolName && <span className="font-mono">{s.toolName}</span>}
                  {s.toolOutput !== null && s.node !== 'final' && <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1 text-[10px]">{JSON.stringify(s.toolOutput)}</pre>}
                </li>
              ))}
            </ol>
            {result?.final && <Alert>{result.final}</Alert>}
            {result?.error && <Alert tone="error">{result.error}</Alert>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlaygroundTab() {
  const tid = useTenantId();
  const models = useQuery({ queryKey: ['ai-models', tid], queryFn: () => api<{ models: { key: string; displayName?: string; tier?: string; capabilities?: string[] }[] }>('/ai/models'), enabled: Boolean(tid) });
  const [picked, setPicked] = useState<string[]>([]);
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const chat = (models.data?.models ?? []).filter((m) => !m.capabilities || m.capabilities.includes('text'));
  useEffect(() => {
    if (!picked.length && chat.length) setPicked(chat.slice(0, 2).map((m) => m.key));
  }, [chat, picked.length]);
  const run = useMutation({
    mutationFn: () => api<({ model: string; ok: true; text: string; latencyMs: number; costUsd: number; usage: { inputTokens: number; outputTokens: number } } | { model: string; ok: false; error: string; latencyMs: number })[]>('/ai/studio/playground', { body: { models: picked, system: system || undefined, prompt } }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {chat.map((m) => (
          <button key={m.key} type="button" aria-pressed={picked.includes(m.key)} onClick={() => setPicked((p) => (p.includes(m.key) ? p.filter((x) => x !== m.key) : p.length < 3 ? [...p, m.key] : p))} className={cn('rounded-full border px-2.5 py-1 font-mono text-[11px]', picked.includes(m.key) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
            {m.key}
          </button>
        ))}
      </div>
      <textarea aria-label="System prompt" rows={2} placeholder="System prompt (optional)" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={system} onChange={(e) => setSystem(e.target.value)} />
      <textarea aria-label="Prompt" rows={4} placeholder="Prompt" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <Button loading={run.isPending} disabled={!picked.length || !prompt.trim()} onClick={() => run.mutate()}>
        <Play className="h-4 w-4" /> Compare {picked.length} model{picked.length === 1 ? '' : 's'}
      </Button>
      {run.data && (
        <div className="grid gap-3 md:grid-cols-3">
          {run.data.map((r) => (
            <Card key={r.model}>
              <CardContent className="space-y-2 p-4">
                <p className="font-mono text-xs font-medium">{r.model}</p>
                {r.ok ? (
                  <>
                    <p className="whitespace-pre-wrap text-sm">{r.text}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {r.latencyMs} ms · {r.usage.inputTokens}+{r.usage.outputTokens} tok · {formatUsd(r.costUsd)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-destructive">{r.error}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Playground calls go through the same gateway: quotas, budgets and the AI ledger apply.</p>
    </div>
  );
}
