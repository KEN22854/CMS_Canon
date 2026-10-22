'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isAgentKey: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const tid = useTenantId();
  const ability = useAbility();
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['api-keys', tid], queryFn: () => api<ApiKeyRow[]>('/api-keys'), enabled: Boolean(tid) });
  const scopes = useQuery({ queryKey: ['api-key-scopes'], queryFn: () => api<string[]>('/api-keys/scopes'), staleTime: Infinity });

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>(['content:read']);
  const [isAgent, setIsAgent] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<ApiKeyRow & { key: string }>('/api-keys', { body: { name, scopes: selected, isAgentKey: isAgent } }),
    onSuccess: (r) => {
      setCreated(r.key);
      setName('');
      void qc.invalidateQueries({ queryKey: ['api-keys', tid] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys', tid] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggle = (s: string) => setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <>
      <PageHeader title="API keys" description="Scoped credentials for integrations, CI and AI agents (MCP)." />

      {ability.can('create', 'ApiKey') && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New key</CardTitle>
            <CardDescription>Grant the narrowest scopes that work. Agent keys get a lower rate limit and are flagged in the audit log.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {created && (
              <Alert tone="success">
                <p className="font-medium">Copy this key now — it will not be shown again.</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-xs">{created}</code>
                  <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(created).then(() => toast.success('Copied'))}>
                    <Copy className="h-3 w-3" /> Copy
                  </Button>
                </div>
              </Alert>
            )}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setCreated(null);
                create.mutate();
              }}
            >
              <div className="max-w-sm space-y-1.5">
                <Label htmlFor="key-name">Name</Label>
                <Input id="key-name" placeholder="Production website" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Scopes</legend>
                <div className="flex flex-wrap gap-2">
                  {scopes.data?.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                      <input type="checkbox" checked={selected.includes(s)} onChange={() => toggle(s)} />
                      {s}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isAgent} onChange={(e) => setIsAgent(e.target.checked)} /> This key is used by an AI agent
              </label>
              <Button type="submit" loading={create.isPending} disabled={name.trim().length < 2 || selected.length === 0}>
                <KeyRound className="h-4 w-4" /> Create key
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <ul className="divide-y">
          {keys.data?.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              {k.isAgentKey ? <Bot className="h-5 w-5 text-muted-foreground" aria-label="Agent key" /> : <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{k.name}</p>
                <p className="text-xs text-muted-foreground">
                  <code>{k.keyPrefix}…</code> · created {relativeTime(k.createdAt)} · {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {k.scopes.map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
              {ability.can('delete', 'ApiKey') && (
                <Button variant="ghost" size="icon" aria-label={`Revoke ${k.name}`} onClick={() => window.confirm(`Revoke "${k.name}"? Integrations using it stop working immediately.`) && revoke.mutate(k.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
          {keys.data?.length === 0 && <li className="px-5 py-4 text-sm text-muted-foreground">No API keys yet.</li>}
        </ul>
      </Card>
    </>
  );
}
