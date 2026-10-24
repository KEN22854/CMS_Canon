'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Laptop, ShieldCheck } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { Field } from '@/components/auth-form';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { relativeTime } from '@/lib/utils';

interface SessionRow {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
}

export default function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" description="Password, two-factor authentication, signed-in devices and your personal data." />
      <div className="space-y-6">
        <TwoFactorCard />
        <PasswordCard />
        <SessionsCard />
        <YourDataCard />
      </div>
    </>
  );
}

function TwoFactorCard() {
  const user = useAuth((s) => s.user);
  const patchUser = useAuth((s) => s.patchUser);
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const begin = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>('/auth/2fa/enable', { body: { password } }),
    onSuccess: async (r) => {
      // QR is rendered locally — the secret never goes to a third-party QR service.
      setEnrollment({ ...r, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 192 }) });
      setPassword('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const confirm = useMutation({
    mutationFn: () => api<{ backupCodes: string[] }>('/auth/2fa/verify', { body: { code } }),
    onSuccess: (r) => {
      setBackupCodes(r.backupCodes);
      setEnrollment(null);
      setCode('');
      patchUser({ twoFactorEnabled: true });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const disable = useMutation({
    mutationFn: () => api('/auth/2fa/disable', { body: { password, code } }),
    onSuccess: () => {
      patchUser({ twoFactorEnabled: false });
      setPassword('');
      setCode('');
      toast.success('Two-factor authentication disabled');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication {user?.twoFactorEnabled && <Badge className="border-success/40 text-success">On</Badge>}
        </CardTitle>
        <CardDescription>A code from an authenticator app (1Password, Google Authenticator, Authy…) is required at sign-in.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {backupCodes && (
          <Alert tone="success">
            <p className="font-medium">Save these backup codes now — they are shown only once.</p>
            <p className="mb-2 text-xs">Each code works one time if you lose your device.</p>
            <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void navigator.clipboard.writeText(backupCodes.join('\n')).then(() => toast.success('Copied'))}>
              <Copy className="h-3 w-3" /> Copy
            </Button>
          </Alert>
        )}

        {!user?.twoFactorEnabled && !enrollment && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              begin.mutate();
            }}
          >
            <div className="min-w-[14rem] flex-1 space-y-1.5">
              <Label htmlFor="tfa-password">Confirm your password</Label>
              <Input id="tfa-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <Button type="submit" loading={begin.isPending} disabled={!password}>
              <ShieldCheck className="h-4 w-4" /> Set up
            </Button>
          </form>
        )}

        {enrollment && (
          <div className="flex flex-wrap gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated in the browser */}
            <img src={enrollment.qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-md border bg-white p-1" />
            <form
              className="min-w-[14rem] flex-1 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              <p className="text-sm">Scan the code, or enter this key manually:</p>
              <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{enrollment.secret}</code>
              <div className="space-y-1.5">
                <Label htmlFor="tfa-code">6-digit code</Label>
                <Input id="tfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              <Button type="submit" loading={confirm.isPending} disabled={code.length < 6}>
                Verify and enable
              </Button>
            </form>
          </div>
        )}

        {user?.twoFactorEnabled && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="tfa-off-password">Password</Label>
              <Input id="tfa-off-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tfa-off-code">Code</Label>
              <Input id="tfa-off-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} className="w-32" />
            </div>
            <Button type="submit" variant="outline" loading={disable.isPending} disabled={!password || code.length < 6}>
              Disable
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const passwordSchema = z
  .object({ currentPassword: z.string().min(1, 'Required'), newPassword: z.string().min(10, 'At least 10 characters'), confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

function PasswordCard() {
  const form = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  const change = useMutation({
    mutationFn: (v: z.infer<typeof passwordSchema>) => api('/auth/change-password', { body: { currentPassword: v.currentPassword, newPassword: v.newPassword } }),
    onSuccess: () => {
      toast.success('Password changed. Other devices were signed out.');
      form.reset();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out all your other devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => change.mutate(v))} className="grid gap-4 md:grid-cols-3" noValidate>
          <Field id="currentPassword" label="Current password" type="password" autoComplete="current-password" registration={form.register('currentPassword')} error={form.formState.errors.currentPassword} />
          <Field id="newPassword" label="New password" type="password" autoComplete="new-password" registration={form.register('newPassword')} error={form.formState.errors.newPassword} />
          <Field id="confirm" label="Confirm" type="password" autoComplete="new-password" registration={form.register('confirm')} error={form.formState.errors.confirm} />
          <div className="md:col-span-3">
            <Button type="submit" loading={change.isPending}>
              Update password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionRow[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Signed-in devices</CardTitle>
        <CardDescription>Revoking a device signs it out within seconds.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <Laptop className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {describeAgent(s.userAgent)} {s.current && <Badge className="ml-1">this device</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.ipAddress ?? 'unknown IP'} · signed in {now ? relativeTime(s.createdAt) : ''} · active {now ? relativeTime(s.lastUsedAt) : ''}
                </p>
              </div>
              {!s.current && (
                <Button size="sm" variant="outline" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** GDPR: a copy of everything about you, and erasure (anonymization) of the account. */
function YourDataCard() {
  const clear = useAuth((s) => s.clear);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [blocked, setBlocked] = useState<{ id: string; name: string }[] | null>(null);
  const erase = useMutation({
    mutationFn: () => api('/me/delete', { body: { password: password || undefined, confirm: 'DELETE' } }),
    onSuccess: () => {
      clear();
      window.location.assign('/login');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) setBlocked((err.details as { workspaces?: { id: string; name: string }[] })?.workspaces ?? []);
      else toast.error(errorMessage(err));
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>Download a copy of your profile, memberships, sessions, activity and AI requests — or delete your account.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Button variant="outline" onClick={() => void download('/me/export', 'canon-my-data.json').catch((err) => toast.error(errorMessage(err)))}>
          Download my data
        </Button>
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium text-destructive">Delete account</p>
          <p className="text-xs text-muted-foreground">Your name and email are erased and you are removed from every workspace. Content you created stays with its workspace, attributed to “Deleted user”. This cannot be undone.</p>
          {blocked && (
            <Alert tone="error">
              You own {blocked.map((w) => w.name).join(', ')}. Transfer ownership to someone else or delete {blocked.length === 1 ? 'that workspace' : 'those workspaces'} first.
            </Alert>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input type="password" aria-label="Current password" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Input aria-label="Type DELETE to confirm" placeholder="Type DELETE to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <Button variant="outline" className="border-destructive/40 text-destructive" disabled={confirm !== 'DELETE'} loading={erase.isPending} onClick={() => erase.mutate()}>
            Delete my account
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
