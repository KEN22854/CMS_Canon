'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n';

const makeSchema = (t: ReturnType<typeof useT>) =>
  z
    .object({ password: z.string().min(10, t('auth.minPassword')), confirm: z.string() })
    .refine((v) => v.password === v.confirm, { message: t('auth.passwordsDiffer'), path: ['confirm'] });

function ResetForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [done, setDone] = useState(false);
  const t = useT();
  const schema = useMemo(() => makeSchema(t), [t]);
  const [error, setError] = useState<string | null>(token ? null : t('auth.missingToken'));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setError(null);
    try {
      await api('/auth/reset-password', { body: { token, password }, auth: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (done) {
    return (
      <AuthCard title={t('auth.passwordUpdated')}>
        <Alert tone="success">{t('auth.passwordChanged')}</Alert>
        <Button className="w-full" onClick={() => router.push('/login')}>
          {t('auth.signIn')}
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('auth.chooseNew')}
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t('auth.backToSignIn')}
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          id="password"
          label={t('auth.newPassword')}
          type="password"
          autoComplete="new-password"
          autoFocus
          registration={form.register('password')}
          error={form.formState.errors.password}
        />
        <Field
          id="confirm"
          label={t('auth.confirmPassword')}
          type="password"
          autoComplete="new-password"
          registration={form.register('confirm')}
          error={form.formState.errors.confirm}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting} disabled={!token}>
          {t('auth.updatePassword')}
        </Button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
