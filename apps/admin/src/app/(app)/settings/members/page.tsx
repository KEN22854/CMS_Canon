'use client';

import { subject } from '@casl/ability';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FieldError, Input, Label, Select } from '@/components/ui';
import { useAbility } from '@/lib/ability';
import { api, errorMessage } from '@/lib/api';
import { useAuth, type MemberRole } from '@/lib/auth-store';
import { useInvitations, useMembers, useTenantId } from '@/lib/queries';
import { relativeTime } from '@/lib/utils';

const ROLES: MemberRole[] = ['OWNER', 'ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER'];
const ROLE_HELP: Record<MemberRole, string> = {
  OWNER: 'Everything, including billing and deleting the workspace',
  ADMIN: 'Everything except billing, deletion and owners',
  EDITOR: 'Create, edit and publish all content; use AI',
  AUTHOR: 'Create content and edit their own; no publishing',
  VIEWER: 'Read-only',
};

const inviteSchema = z.object({ email: z.email('Enter a valid email'), role: z.enum(['OWNER', 'ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER']) });

export default function MembersPage() {
  const tid = useTenantId();
  const me = useAuth((s) => s.user);
  const myRole = useAuth((s) => s.tenant?.role);
  const ability = useAbility();
  const canInvite = ability.can('invite', 'Member');
  const members = useMembers();
  const invitations = useInvitations(canInvite);
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members', tid] });
    void qc.invalidateQueries({ queryKey: ['invitations', tid] });
    void qc.invalidateQueries({ queryKey: ['quota', tid] });
  };

  const form = useForm<z.infer<typeof inviteSchema>>({ resolver: zodResolver(inviteSchema), defaultValues: { role: 'EDITOR' } });
  const invite = useMutation({
    mutationFn: (v: z.infer<typeof inviteSchema>) => api(`/tenants/${tid}/members/invite`, { body: v }),
    onSuccess: (_, v) => {
      toast.success(`Invitation sent to ${v.email}`);
      form.reset({ email: '', role: v.role });
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) => api(`/tenants/${tid}/members/${userId}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => {
      toast.success('Role updated');
      refresh();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/tenants/${tid}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Member removed');
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/tenants/${tid}/invitations/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Only owners may hand out ownership; the API enforces the same rule.
  const assignable = ROLES.filter((r) => r !== 'OWNER' || myRole === 'OWNER');

  return (
    <>
      <PageHeader title="Members" description="Who can access this workspace and what they can do." />

      {canInvite && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Invite someone</CardTitle>
            <CardDescription>They get an email link valid for 7 days. Pending invitations count towards your plan's seats.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} className="flex flex-wrap items-end gap-3" noValidate>
              <div className="min-w-[14rem] flex-1 space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" placeholder="colleague@company.com" {...form.register('email')} aria-invalid={form.formState.errors.email ? true : undefined} />
                <FieldError message={form.formState.errors.email?.message} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select id="invite-role" {...form.register('role')}>
                  {assignable.map((r) => (
                    <option key={r} value={r}>
                      {r.charAt(0) + r.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" loading={invite.isPending}>
                Send invitation
              </Button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">{ROLE_HELP[form.watch('role')]}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Member</th>
                <th className="px-5 py-3 font-medium">Role</th>
                <th className="px-5 py-3 font-medium">Last sign-in</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => {
                const editable = ability.can('update', subject('Member', { tenantId: tid, role: m.role }));
                const removable = m.id === me?.id || ability.can('delete', subject('Member', { tenantId: tid, role: m.role }));
                return (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 font-medium">
                        {m.name}
                        {m.id === me?.id && <Badge>you</Badge>}
                        {m.twoFactorEnabled && <ShieldCheck className="h-4 w-4 text-success" aria-label="Two-factor enabled" />}
                      </div>
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      {editable ? (
                        <Select aria-label={`Role of ${m.name}`} value={m.role} disabled={changeRole.isPending} onChange={(e) => changeRole.mutate({ userId: m.id, role: e.target.value as MemberRole })}>
                          {(m.role === 'OWNER' ? ROLES : assignable).map((r) => (
                            <option key={r} value={r}>
                              {r.charAt(0) + r.slice(1).toLowerCase()}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge>{m.role.toLowerCase()}</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{m.lastLoginAt ? relativeTime(m.lastLoginAt) : '—'}</td>
                    <td className="px-5 py-3 text-right">
                      {removable && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={m.id === me?.id ? 'Leave workspace' : `Remove ${m.name}`}
                          onClick={() => window.confirm(m.id === me?.id ? 'Leave this workspace?' : `Remove ${m.name}?`) && remove.mutate(m.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {invitations.data?.map((inv) => (
                <tr key={inv.id} className="border-b bg-muted/30 last:border-0">
                  <td className="px-5 py-3">
                    <div className="font-medium">{inv.email}</div>
                    <div className="text-xs text-muted-foreground">Invited {relativeTime(inv.createdAt)} · pending</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge>{inv.role.toLowerCase()}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">—</td>
                  <td className="px-5 py-3 text-right">
                    <Button variant="ghost" size="icon" aria-label={`Revoke invitation for ${inv.email}`} onClick={() => revoke.mutate(inv.id)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {members.isPending && <p className="p-5 text-sm text-muted-foreground">Loading…</p>}
      </Card>
    </>
  );
}
