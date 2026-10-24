'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Plug, Plus, RefreshCw, Send, ShieldCheck, Trash2, Upload, Webhook as WebhookIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { PERMISSION_LABEL, usePlugins, useWebhooks, type Delivery, type PluginListing, type Webhook } from '@/lib/platform';
import { useTenantId } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';

type Tab = 'marketplace' | 'webhooks';

export default function IntegrationsPage() {
  const ability = useAbility();
  const [tab, setTab] = useState<Tab>('marketplace');
  return (
    <>
      <PageHeader title="Integrations" description="Plugins from the marketplace, your private plugins, and webhooks to your own systems." />
      <div className="mb-6 flex gap-1 border-b" role="tablist">
        {(
          [
            ['marketplace', 'Plugins', Plug],
            ['webhooks', 'Webhooks', WebhookIcon],
          ] as const
        ).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', tab === id ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </button>
        ))}
      </div>
      {tab === 'marketplace' ? <Marketplace canManage={ability.can('manage', 'Plugin')} /> : <Webhooks canManage={ability.can('create', 'Webhook')} />}
    </>
  );
}

// ── Plugins ───────────────────────────────────────────────────────────────────

function Marketplace({ canManage }: { canManage: boolean }) {
  const plugins = usePlugins();
  const [open, setOpen] = useState<PluginListing | null>(null);
  const [uploading, setUploading] = useState(false);
  if (plugins.isError) return <Alert tone="error">{errorMessage(plugins.error)}</Alert>;
  const list = plugins.data ?? [];
  const installed = list.filter((p) => p.installation);
  const available = list.filter((p) => !p.installation);
  return (
    <div className="space-y-8">
      {installed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Installed</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {installed.map((p) => (
              <PluginCard key={p.id} p={p} onOpen={() => setOpen(p)} />
            ))}
          </div>
        </section>
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Marketplace</h2>
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => setUploading(true)}>
              <Upload className="h-4 w-4" /> Add a private plugin
            </Button>
          )}
        </div>
        {uploading && <PrivatePlugin onDone={() => setUploading(false)} />}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {available.map((p) => (
            <PluginCard key={p.id} p={p} onOpen={() => setOpen(p)} />
          ))}
        </div>
      </section>
      {open && <PluginDialog p={list.find((x) => x.id === open.id) ?? open} canManage={canManage} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PluginCard({ p, onOpen }: { p: PluginListing; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="text-left">
      <Card className="h-full transition-colors hover:border-primary/50">
        <CardContent className="flex gap-3 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xl" aria-hidden>
            {p.icon ?? '🔌'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {p.displayName}
              {p.private && <Badge>private</Badge>}
              {p.installation && !p.installation.isActive && <Badge className="border-warning/40 text-warning">paused</Badge>}
              {p.installation?.needsConsent && <Badge className="border-warning/40 text-warning">update needs consent</Badge>}
            </p>
            <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {p.author} · v{p.version} · {p.category}
            </p>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

function PluginDialog({ p, canManage, onClose }: { p: PluginListing; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const inst = p.installation;
  const [settings, setSettings] = useState<Record<string, string | boolean>>(() => ({ ...(inst?.settings ?? {}) }));
  const [consent, setConsent] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['plugins', tid] });
  const install = useMutation({
    mutationFn: () => api<PluginListing & { apiKey: string | null }>(`/plugins/${p.id}/install`, { body: { settings, grantedPermissions: p.permissions } }),
    onSuccess: (r) => {
      void refresh();
      toast.success(`${p.displayName} installed`);
      if (r.apiKey) setIssuedKey(r.apiKey);
      else onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/plugins/installations/${inst!.id}`, { method: 'PATCH', body }),
    onSuccess: () => (void refresh(), toast.success('Saved')),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/plugins/installations/${inst!.id}`, { method: 'DELETE' }),
    onSuccess: () => (void refresh(), toast.success('Uninstalled — its API key is revoked'), onClose()),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const needsConsent = !inst ? p.permissions.length > 0 : inst.needsConsent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={p.displayName} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span aria-hidden>{p.icon ?? '🔌'}</span> {p.displayName}
          </CardTitle>
          <CardDescription>{p.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {issuedKey ? (
            <div className="space-y-2">
              <Alert>Copy this API key into the automation platform now — it is shown only once.</Alert>
              <div className="flex gap-2">
                <Input readOnly value={issuedKey} className="font-mono text-xs" aria-label="API key" />
                <Button variant="outline" onClick={() => void navigator.clipboard.writeText(issuedKey).then(() => toast.success('Copied'))}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <Button className="w-full" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : (
            <>
              {p.events.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Receives events</p>
                  <div className="flex flex-wrap gap-1">
                    {p.events.map((e) => (
                      <Badge key={e}>{e}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {p.blocks.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Adds to the page builder</p>
                  <ul className="list-disc pl-5 text-sm">
                    {p.blocks.map((b) => (
                      <li key={b.key}>
                        {b.name} <span className="text-muted-foreground">— {b.description}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.settings.map((s) => (
                <div key={s.key} className="space-y-1">
                  <Label htmlFor={`ps-${s.key}`}>
                    {s.label}
                    {s.required && ' *'}
                  </Label>
                  {s.kind === 'toggle' ? (
                    <input id={`ps-${s.key}`} type="checkbox" checked={Boolean(settings[s.key])} disabled={!canManage} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.checked })} />
                  ) : s.kind === 'select' ? (
                    <Select id={`ps-${s.key}`} value={String(settings[s.key] ?? '')} disabled={!canManage} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })}>
                      <option value="">—</option>
                      {s.options?.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </Select>
                  ) : (
                    <Input id={`ps-${s.key}`} type={s.kind === 'secret' ? 'password' : s.kind === 'url' ? 'url' : 'text'} placeholder={s.placeholder} value={String(settings[s.key] ?? '')} disabled={!canManage} onChange={(e) => setSettings({ ...settings, [s.key]: e.target.value })} />
                  )}
                  {s.help && <p className="text-[11px] text-muted-foreground">{s.help}</p>}
                </div>
              ))}
              {p.permissions.length > 0 && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> This plugin will be able to
                  </p>
                  <ul className="list-disc pl-5 text-sm">
                    {p.permissions.map((x) => (
                      <li key={x}>
                        {PERMISSION_LABEL[x] ?? x}
                        {inst && !inst.grantedPermissions.includes(x) && <Badge className="ml-1 border-warning/40 text-warning">new</Badge>}
                      </li>
                    ))}
                  </ul>
                  {needsConsent && canManage && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I allow these permissions
                    </label>
                  )}
                  <p className="text-[11px] text-muted-foreground">It acts through its own API key, visible in the audit log, revoked on uninstall.</p>
                </div>
              )}
              {canManage && (
                <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
                  {inst ? (
                    <>
                      <div className="flex gap-2">
                        <Button variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => window.confirm(`Uninstall ${p.displayName}?`) && remove.mutate()}>
                          <Trash2 className="h-4 w-4" /> Uninstall
                        </Button>
                        <Button variant="outline" onClick={() => update.mutate({ isActive: !inst.isActive })}>
                          {inst.isActive ? 'Pause' : 'Resume'}
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        {inst.needsConsent && (
                          <Button variant="outline" disabled={!consent} onClick={() => update.mutate({ grantedPermissions: p.permissions })}>
                            Accept update
                          </Button>
                        )}
                        {p.settings.length > 0 && (
                          <Button loading={update.isPending} onClick={() => update.mutate({ settings })}>
                            Save settings
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={onClose}>
                        Cancel
                      </Button>
                      <Button disabled={needsConsent && !consent} loading={install.isPending} onClick={() => install.mutate()}>
                        Install
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PrivatePlugin({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const [text, setText] = useState('');
  const register = useMutation({
    mutationFn: () => api<PluginListing>('/plugins', { body: { manifest: JSON.parse(text) as unknown } }),
    onSuccess: (p) => (void qc.invalidateQueries({ queryKey: ['plugins', tid] }), toast.success(`${p.displayName} v${p.version} registered`), onDone()),
    onError: (err) => toast.error(err instanceof SyntaxError ? 'The manifest is not valid JSON' : errorMessage(err)),
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Paste a plugin manifest (<code>canon-plugin.json</code>). Private plugins are visible only to this workspace; uploading a newer version keeps installs on their granted permissions until someone consents.
        </p>
        <textarea aria-label="Plugin manifest" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "name": "crm-sync", "version": "1.0.0", "displayName": "CRM sync", … }' className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button disabled={!text.trim()} loading={register.isPending} onClick={() => register.mutate()}>
            Register
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

function Webhooks({ canManage }: { canManage: boolean }) {
  const hooks = useWebhooks();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Canon POSTs a JSON envelope for each event, signed with <code>Canon-Signature: t=…,v1=HMAC-SHA256(secret, &quot;t.body&quot;)</code>. Retries back off for about an hour; an <code>Idempotency-Key</code> stays the same across retries. Endpoints that keep failing are paused.
        </p>
        {canManage && !creating && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> Add endpoint
          </Button>
        )}
      </div>
      {secret && (
        <Alert>
          <p className="font-medium">Signing secret — shown once</p>
          <div className="mt-2 flex gap-2">
            <Input readOnly value={secret} className="font-mono text-xs" aria-label="Signing secret" />
            <Button variant="outline" onClick={() => void navigator.clipboard.writeText(secret).then(() => toast.success('Copied'))}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button variant="ghost" onClick={() => setSecret(null)}>
              Done
            </Button>
          </div>
        </Alert>
      )}
      {creating && <WebhookForm onDone={(s) => (setCreating(false), s && setSecret(s))} />}
      {hooks.isError && <Alert tone="error">{errorMessage(hooks.error)}</Alert>}
      <div className="space-y-3">
        {hooks.data?.map((h) => (
          <WebhookRow key={h.id} h={h} canManage={canManage} open={selected === h.id} onToggle={() => setSelected(selected === h.id ? null : h.id)} onSecret={setSecret} />
        ))}
        {hooks.data?.length === 0 && !creating && <p className="py-8 text-center text-sm text-muted-foreground">No endpoints yet.</p>}
      </div>
    </div>
  );
}

function WebhookForm({ onDone }: { onDone: (secret?: string) => void }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: () => api<string[]>('/webhooks/events') });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>(['page.published']);
  const create = useMutation({
    mutationFn: () => api<Webhook & { secret: string }>('/webhooks', { body: { name, url, events: picked } }),
    onSuccess: (r) => (void qc.invalidateQueries({ queryKey: ['webhooks', tid] }), onDone(r.secret)),
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="wh-name">Name</Label>
            <Input id="wh-name" value={name} placeholder="CRM sync" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="wh-url">Endpoint URL</Label>
            <Input id="wh-url" type="url" value={url} placeholder="https://example.com/canon/webhook" onChange={(e) => setUrl(e.target.value)} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Events</p>
          <div className="flex flex-wrap gap-2">
            {['*', ...(events.data ?? [])].map((e) => (
              <label key={e} className={cn('flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs', picked.includes(e) && 'border-primary bg-primary/10')}>
                <input type="checkbox" className="sr-only" checked={picked.includes(e)} onChange={(x) => setPicked(x.target.checked ? [...picked, e] : picked.filter((p) => p !== e))} />
                {e === '*' ? 'all events' : e}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !url || !picked.length} loading={create.isPending} onClick={() => create.mutate()}>
            Create endpoint
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const DELIVERY_TONE: Record<Delivery['status'], string> = {
  SUCCEEDED: 'border-success/40 text-success',
  PENDING: 'border-muted-foreground/30 text-muted-foreground',
  FAILED: 'border-warning/40 text-warning',
  DEAD: 'border-destructive/40 text-destructive',
};

function WebhookRow({ h, canManage, open, onToggle, onSecret }: { h: Webhook; canManage: boolean; open: boolean; onToggle: () => void; onSecret: (s: string) => void }) {
  const qc = useQueryClient();
  const tid = useTenantId();
  const deliveries = useQuery({ queryKey: ['deliveries', tid, h.id], queryFn: () => api<Delivery[]>(`/webhooks/${h.id}/deliveries`), enabled: open, refetchInterval: open ? 5_000 : false });
  const act = useMutation({
    mutationFn: (op: 'test' | 'rotate' | 'toggle' | 'delete' | { redeliver: string }) =>
      typeof op === 'object'
        ? api(`/webhooks/deliveries/${op.redeliver}/redeliver`, { body: {} })
        : op === 'test'
          ? api(`/webhooks/${h.id}/test`, { body: {} })
          : op === 'rotate'
            ? api<{ secret: string }>(`/webhooks/${h.id}/rotate-secret`, { body: {} })
            : op === 'toggle'
              ? api(`/webhooks/${h.id}`, { method: 'PATCH', body: { isActive: !h.isActive } })
              : api(`/webhooks/${h.id}`, { method: 'DELETE' }),
    onSuccess: (r, op) => {
      void qc.invalidateQueries({ queryKey: ['webhooks', tid] });
      void qc.invalidateQueries({ queryKey: ['deliveries', tid, h.id] });
      if (op === 'rotate') onSecret((r as { secret: string }).secret);
      if (op === 'test') toast.success('Ping queued');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
            <p className="flex items-center gap-2 font-medium">
              {h.name}
              {!h.isActive && <Badge className="border-warning/40 text-warning">paused</Badge>}
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">{h.url}</p>
            <p className="text-[11px] text-muted-foreground">
              {h.events.join(', ')} {h.lastTriggeredAt && `· last ${relativeTime(h.lastTriggeredAt)}`}
            </p>
          </button>
          {canManage && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => act.mutate('test')} title="Send test ping">
                <Send className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => window.confirm('Rotate the signing secret? The old one stops working immediately.') && act.mutate('rotate')} title="Rotate secret">
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => act.mutate('toggle')}>
                {h.isActive ? 'Pause' : 'Resume'}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => window.confirm(`Delete ${h.name}?`) && act.mutate('delete')} aria-label="Delete endpoint">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
        {h.disabledReason && (
          <p className="mt-2 flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {h.disabledReason}
          </p>
        )}
        {open && (
          <div className="mt-3 overflow-x-auto border-t pt-3">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 font-medium">Event</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 font-medium">Response</th>
                  <th className="py-1 font-medium">Attempts</th>
                  <th className="py-1 font-medium">When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.data?.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="py-1.5">
                      <code>{d.event}</code>
                    </td>
                    <td className="py-1.5">
                      <Badge className={DELIVERY_TONE[d.status]}>{d.status.toLowerCase()}</Badge>
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {d.responseStatus ?? '—'} {d.durationMs !== null && `· ${d.durationMs} ms`} {d.error && <span className="text-destructive">· {d.error}</span>}
                    </td>
                    <td className="py-1.5">{d.attempts}</td>
                    <td className="py-1.5 text-muted-foreground">{relativeTime(d.createdAt)}</td>
                    <td className="py-1.5 text-right">
                      {canManage && d.status !== 'PENDING' && (
                        <button type="button" className="text-primary hover:underline" onClick={() => act.mutate({ redeliver: d.id })}>
                          Redeliver
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {deliveries.data?.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-center text-muted-foreground">
                      No deliveries yet — send a test ping.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
