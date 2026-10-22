'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

const schema = z
  .object({ password: z.string().min(10, 'At least 10 characters'), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

function ResetForm() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its token.');
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
      <AuthCard title="Password updated">
        <Alert tone="success">Your password was changed and every session was signed out.</Alert>
        <Button className="w-full" onClick={() => router.push('/login')}>
          Sign in
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      footer={
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field id="password" label="New password" type="password" autoComplete="new-password" autoFocus registration={form.register('password')} error={form.formState.errors.password} />
        <Field id="confirm" label="Confirm password" type="password" autoComplete="new-password" registration={form.register('confirm')} error={form.formState.errors.confirm} />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting} disabled={!token}>
          Update password
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
