'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';
import { useT } from '@/lib/i18n';

const makeSchema = (t: ReturnType<typeof useT>) =>
  z.object({
    name: z.string().trim().min(1, t('auth.nameRequired')).max(100),
    email: z.email(t('auth.invalidEmail')),
    password: z.string().min(10, t('auth.minPassword')),
    tenantName: z.string().trim().max(80).optional(),
  });
type Values = z.infer<ReturnType<typeof makeSchema>>;

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
  const t = useT();
  const schema = useMemo(() => makeSchema(t), [t]);

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
      <AuthCard title={t('auth.checkEmail')} description={t('auth.sentTo', { email: sentTo })}>
        <div className="flex justify-center py-2 text-primary">
          <MailCheck className="h-10 w-10" aria-hidden />
        </div>
        {process.env.NODE_ENV === 'development' && (
          <Alert>
            {t('auth.devMailpit')}{' '}
            <a
              className="font-medium underline"
              href="http://localhost:8035"
              target="_blank"
              rel="noreferrer"
            >
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
      title={invited ? t('auth.join', { name: invite.data?.tenant.name ?? '' }) : t('auth.createWorkspace')}
      description={
        invited
          ? t('auth.invitedAs', {
              who: invite.data?.invitedBy ?? '',
              role: invite.data?.role.toLowerCase() ?? '',
            })
          : t('auth.freeWorkspace')
      }
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link
            href={inviteToken ? `/login?next=/invite/${inviteToken}` : '/login'}
            className="font-medium text-primary hover:underline"
          >
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      {invite.data && !invited && (
        <Alert tone="warning">{t('auth.inviteState', { state: invite.data.state })}</Alert>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          id="name"
          label={t('auth.yourName')}
          autoComplete="name"
          autoFocus
          registration={form.register('name')}
          error={form.formState.errors.name}
        />
        <Field
          id="email"
          label={t('auth.workEmail')}
          type="email"
          autoComplete="email"
          readOnly={invited}
          registration={form.register('email')}
          error={form.formState.errors.email}
        />
        <Field
          id="password"
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          registration={form.register('password')}
          error={form.formState.errors.password}
        />
        {!invited && (
          <Field
            id="tenantName"
            label={t('auth.workspaceName')}
            placeholder="Acme Inc."
            registration={form.register('tenantName')}
            error={form.formState.errors.tenantName}
          />
        )}
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
          {invited ? t('auth.acceptCreate') : t('auth.createAccount')}
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
