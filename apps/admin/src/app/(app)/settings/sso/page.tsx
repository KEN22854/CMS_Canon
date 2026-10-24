'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, KeyRound, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { useSso, type SsoView } from '@/lib/platform';
import { useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

interface Form {
  name: string;
  domains: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  enforced: boolean;
  jitProvisioning: boolean;
  defaultRole: 'ADMIN' | 'EDITOR' | 'AUTHOR' | 'VIEWER';
  isActive: boolean;
}

const fromView = (v: SsoView | undefined): Form => ({
  name: v?.connection?.name ?? '',
  domains: v?.connection?.domains.join(', ') ?? '',
  idpEntityId: v?.connection?.idpEntityId ?? '',
  idpSsoUrl: v?.connection?.idpSsoUrl ?? '',
  idpCertificate: '',
  enforced: v?.connection?.enforced ?? false,
  jitProvisioning: v?.connection?.jitProvisioning ?? true,
  defaultRole: v?.connection?.defaultRole ?? 'VIEWER',
  isActive: v?.connection?.isActive ?? true,
});

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" aria-label={label} />
        <Button variant="outline" onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success('Copied'))} aria-label={`Copy ${label}`}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export default function SsoPage() {
  const plan = useAuth((s) => s.tenant?.plan);
  const sso = useSso(plan === 'ENTERPRISE');
  const qc = useQueryClient();
  const tid = useTenantId();
  const [form, setForm] = useState<Form>(() => fromView(undefined));
  useEffect(() => setForm(fromView(sso.data)), [sso.data]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      // Certificates are write-only: leaving the box empty keeps the stored one.
      const cert = form.idpCertificate.trim();
      return api<SsoView>('/sso', { method: 'PUT', body: { ...form, domains: form.domains.split(/[\s,]+/).filter(Boolean), idpCertificate: cert || undefined } });
    },
    onSuccess: (v) => (qc.setQueryData(['sso', tid], v), toast.success('SSO connection saved')),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const verify = useMutation({
    mutationFn: (domain: string) => api<SsoView>('/sso/domains/verify', { body: { domain } }),
    onSuccess: (v, d) => (qc.setQueryData(['sso', tid], v), toast.success(`${d} verified`)),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api('/sso', { method: 'DELETE' }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['sso', tid] }), toast.success('SSO removed — everyone signs in with a password again')),
  });

  if (plan !== 'ENTERPRISE') {
    return (
      <>
        <PageHeader title="Single sign-on" description="SAML 2.0 with Okta, Microsoft Entra ID, Google Workspace, OneLogin…" />
        <Alert>
          SSO is part of the Enterprise plan. <Link href="/settings/billing" className="font-medium underline">See plans</Link>
        </Alert>
      </>
    );
  }
  if (sso.isPending) return <Loader2 className="mx-auto mt-16 h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (sso.isError) return <Alert tone="error">{errorMessage(sso.error)}</Alert>;
  const v = sso.data!;

  return (
    <>
      <PageHeader title="Single sign-on" description="People on your company domains sign in through your identity provider; new ones are provisioned on first login." />
      <div className="space-y-6">
        {v.serviceProvider && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">1 · Give these to your identity provider</CardTitle>
              <CardDescription>Or upload the metadata URL. NameID format: email address; sign the assertion.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <CopyField label="ACS (reply) URL" value={v.serviceProvider.acsUrl} />
              <CopyField label="Entity ID (audience)" value={v.serviceProvider.entityId} />
              <CopyField label="Metadata URL" value={v.serviceProvider.metadataUrl} />
              <CopyField label="Sign-in URL (for an IdP tile)" value={v.serviceProvider.loginUrl} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{v.connection ? '2 · Identity provider' : 'Connect an identity provider'}</CardTitle>
            {v.connection?.lastLoginAt && <CardDescription>Last SSO sign-in {relativeTime(v.connection.lastLoginAt)}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sso-name">Name</Label>
                <Input id="sso-name" value={form.name} placeholder="Acme Okta" onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sso-domains">Email domains</Label>
                <Input id="sso-domains" value={form.domains} placeholder="acme.com, acme.de" onChange={(e) => set('domains', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sso-entity">IdP entity ID (issuer)</Label>
                <Input id="sso-entity" value={form.idpEntityId} placeholder="http://www.okta.com/exk…" onChange={(e) => set('idpEntityId', e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sso-url">IdP single sign-on URL</Label>
                <Input id="sso-url" type="url" value={form.idpSsoUrl} placeholder="https://acme.okta.com/app/…/sso/saml" onChange={(e) => set('idpSsoUrl', e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sso-cert">IdP signing certificate (PEM)</Label>
              <textarea id="sso-cert" rows={4} value={form.idpCertificate} placeholder={v.connection ? `Stored — SHA-256 ${v.connection.certificateFingerprint ?? ''}. Paste a new one to replace it.` : '-----BEGIN CERTIFICATE-----'} onChange={(e) => set('idpCertificate', e.target.value)} className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs" />
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="sso-role">Role for new people</Label>
                <Select id="sso-role" value={form.defaultRole} onChange={(e) => set('defaultRole', e.target.value as Form['defaultRole'])}>
                  {['VIEWER', 'AUTHOR', 'EDITOR', 'ADMIN'].map((r) => (
                    <option key={r} value={r}>
                      {r.toLowerCase()}
                    </option>
                  ))}
                </Select>
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" checked={form.jitProvisioning} onChange={(e) => set('jitProvisioning', e.target.checked)} /> Create accounts on first sign-in
              </label>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" checked={form.enforced} onChange={(e) => set('enforced', e.target.checked)} /> Require SSO (owners keep password access)
              </label>
            </div>
            <div className="flex justify-between gap-2">
              {v.connection ? (
                <Button variant="ghost" className="text-destructive" onClick={() => window.confirm('Remove SSO? People will need passwords again.') && remove.mutate()}>
                  Remove SSO
                </Button>
              ) : (
                <span />
              )}
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                Save connection
              </Button>
            </div>
          </CardContent>
        </Card>

        {v.domains.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">3 · Prove you own the domains</CardTitle>
              <CardDescription>Only verified domains route sign-ins to your IdP. Add a TXT record, then verify.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {v.domains.map((d) => (
                <div key={d.domain} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      {d.domain} {d.verified ? <Badge className="border-success/40 text-success"><CheckCircle2 className="mr-1 h-3 w-3" />verified</Badge> : <Badge className="border-warning/40 text-warning">not verified</Badge>}
                    </p>
                    {!d.verified && (
                      <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                        {d.record.type} {d.record.name} &quot;{d.record.value}&quot;
                      </p>
                    )}
                  </div>
                  {!d.verified && (
                    <Button size="sm" variant="outline" loading={verify.isPending && verify.variables === d.domain} onClick={() => verify.mutate(d.domain)}>
                      Verify
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Sign-ins through the IdP skip Canon two-factor: your IdP enforces MFA. Every SSO login and provisioned account is in the audit log.
        </p>
      </div>
    </>
  );
}

