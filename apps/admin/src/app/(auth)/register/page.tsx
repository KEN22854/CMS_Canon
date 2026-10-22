'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';

const schema = z.object({
  name: z.string().trim().min(1, 'Tell us your name').max(100),
  email: z.email('Enter a valid email'),
  password: z.string().min(10, 'At least 10 characters'),
  tenantName: z.string().trim().max(80).optional(),
});
type Values = z.infer<typeof schema>;

interface InvitePreview {
  email: string;
  role: string;
  tenant: { name: string };
  invitedBy: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

function RegisterForm() {
  const router = useRouter();
  const inviteToken = useSearchParams().get('invite');
  const setSession = useAuth((s) => s.setSession);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; suggestions?: string[] } | null>(null);

  const invite = useQuery({
    queryKey: ['invite', inviteToken],
    queryFn: () => api<InvitePreview>(`/invitations/${inviteToken}`, { auth: false }),
    enabled: Boolean(inviteToken),
  });

  const form = useForm<Values>({ resolver: zodResolver(schema) });
  useEffect(() => {
    if (invite.data) form.setValue('email', invite.data.email);
  }, [invite.data, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<AuthPayload | { status: 'check_email' }>('/auth/register', {
        body: { ...values, tenantName: values.tenantName || undefined, inviteToken: invite.data?.state === 'pending' ? inviteToken : undefined },
        auth: false,
      });
      if ('accessToken' in res) {
        setSession(res);
        router.replace('/');
      } else {
        setSentTo(values.email);
      }
    } catch (err) {
      const suggestions = err instanceof ApiError ? (err.details as { suggestions?: string[] } | undefined)?.suggestions : undefined;
      setError({ message: errorMessage(err), suggestions });
    }
  });

  if (sentTo) {
    return (
      <AuthCard title="Check your email" description={<>We sent a confirmation link to <strong>{sentTo}</strong>. It expires in 24 hours.</>}>
        <div className="flex justify-center py-2 text-primary">
          <MailCheck className="h-10 w-10" aria-hidden />
        </div>
        {process.env.NODE_ENV === 'development' && (
          <Alert>
            Local dev: open Mailpit at{' '}
            <a className="font-medium underline" href="http://localhost:8035" target="_blank" rel="noreferrer">
              localhost:8035
            </a>
          </Alert>
        )}
      </AuthCard>
    );
  }

  const invited = invite.data?.state === 'pending';
  return (
    <AuthCard
      title={invited ? `Join ${invite.data?.tenant.name}` : 'Create your workspace'}
      description={invited ? `${invite.data?.invitedBy} invited you as ${invite.data?.role.toLowerCase()}.` : 'Start with a free workspace. No card required.'}
      footer={
        <>
          Already have an account?{' '}
          <Link href={inviteToken ? `/login?next=/invite/${inviteToken}` : '/login'} className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {invite.data && !invited && <Alert tone="warning">This invitation is {invite.data.state}. You can still create your own workspace.</Alert>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="name" label="Your name" autoComplete="name" autoFocus registration={form.register('name')} error={form.formState.errors.name} />
        <Field id="email" label="Work email" type="email" autoComplete="email" readOnly={invited} registration={form.register('email')} error={form.formState.errors.email} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" registration={form.register('password')} error={form.formState.errors.password} />
        {!invited && <Field id="tenantName" label="Workspace name" placeholder="Acme Inc." registration={form.register('tenantName')} error={form.formState.errors.tenantName} />}
        {error && (
          <Alert tone="error">
            {error.message}
            {error.suggestions && error.suggestions.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {error.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          {invited ? 'Accept and create account' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
