'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const schema = useMemo(() => z.object({ email: z.email(t('auth.invalidEmail')) }), [t]);
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api('/auth/forgot-password', { body: values, auth: false });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <AuthCard
      title={t('auth.resetTitle')}
      description={t('auth.resetDescription')}
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          {t('auth.backToSignIn')}
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success">{t('auth.resetSent')}</Alert>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field
            id="email"
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            autoFocus
            registration={form.register('email')}
            error={form.formState.errors.email}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
            {t('auth.sendReset')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
