'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthCard } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage, refreshSession } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';

interface InvitePreview {
  email: string;
  role: string;
  tenant: { name: string };
  invitedBy: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { status, user, setSession } = useAuth();

  useEffect(() => {
    if (status === 'unknown') void refreshSession();
  }, [status]);

  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api<InvitePreview>(`/invitations/${token}`, { auth: false }) });

  const accept = useMutation({
    mutationFn: async () => {
      const { tenantId } = await api<{ tenantId: string }>('/invitations/accept', { body: { token } });
      // Membership exists now; switch the session into the new tenant right away.
      setSession(await api<AuthPayload>('/auth/switch-tenant', { body: { tenantId } }));
    },
    onSuccess: () => router.replace('/'),
  });

  if (preview.isPending) return <AuthCard title="Loading invitation…">{null}</AuthCard>;
  if (preview.isError) {
    return (
      <AuthCard title="Invitation not found">
        <Alert tone="error">This invitation link is invalid.</Alert>
      </AuthCard>
    );
  }

  const inv = preview.data;
  const wrongAccount = user && user.email.toLowerCase() !== inv.email.toLowerCase();
  return (
    <AuthCard title={`Join ${inv.tenant.name}`} description={`${inv.invitedBy} invited ${inv.email} as ${inv.role.toLowerCase()}.`}>
      {inv.state !== 'pending' && <Alert tone="warning">This invitation is {inv.state}.</Alert>}
      {inv.state === 'pending' && status === 'authenticated' && !wrongAccount && (
        <>
          {accept.isError && <Alert tone="error">{errorMessage(accept.error)}</Alert>}
          <Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
            Accept invitation
          </Button>
        </>
      )}
      {inv.state === 'pending' && wrongAccount && (
        <Alert tone="warning">
          You are signed in as {user.email}. Sign out and use {inv.email} to accept.
        </Alert>
      )}
      {inv.state === 'pending' && status === 'anonymous' && (
        <div className="space-y-2">
          <Button className="w-full" onClick={() => router.push(`/register?invite=${token}`)}>
            Create account
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href={`/login?next=/invite/${token}`} className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      )}
    </AuthCard>
  );
}
