'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AuthCard, Field } from '@/components/auth-form';
import { Alert, Button } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';

const credentials = z.object({ email: z.email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });
const mfa = z.object({ code: z.string().trim().min(6, 'Enter the 6-digit code or a backup code').max(12) });

type LoginResponse = AuthPayload | { mfaRequired: true; mfaToken: string };

/** Why an SSO round trip came back to the login page (?sso_error=CODE). */
const SSO_ERRORS: Record<string, string> = {
  SSO_INVALID_RESPONSE: 'Your identity provider’s response could not be verified. Try again, or ask your admin to check the SSO certificate.',
  SSO_DOMAIN_MISMATCH: 'Your identity provider signed you in with an address this workspace has not verified.',
  SSO_NOT_A_MEMBER: 'You are not a member of this workspace yet — ask an admin to invite you.',
  SSO_NO_EMAIL: 'Your identity provider did not share your email address.',
  ACCOUNT_DISABLED: 'This account is disabled.',
  NOT_FOUND: 'This SSO connection no longer exists.',
};

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const ssoError = params.get('sso_error');
  const [ssoBusy, setSsoBusy] = useState(false);
  const setSession = useAuth((s) => s.setSession);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string; loginUrl?: string } | null>(null);
  const [resent, setResent] = useState(false);

  const form = useForm<z.infer<typeof credentials>>({ resolver: zodResolver(credentials) });
  const codeForm = useForm<z.infer<typeof mfa>>({ resolver: zodResolver(mfa) });

  const done = (p: AuthPayload) => {
    setSession(p);
    router.replace(next);
  };

  const onLogin = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', { body: values, auth: false });
      if ('mfaRequired' in res) setMfaToken(res.mfaToken);
      else done(res);
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'UNKNOWN', message: errorMessage(err), loginUrl: err instanceof ApiError ? (err.details as { loginUrl?: string } | undefined)?.loginUrl : undefined });
    }
  });

  const onCode = codeForm.handleSubmit(async ({ code }) => {
    setError(null);
    try {
      done(await api<AuthPayload>('/auth/2fa/login', { body: { mfaToken, code }, auth: false }));
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'UNKNOWN', message: errorMessage(err) });
    }
  });

  /** Step 1 for SSO users: the email's domain decides which identity provider to bounce to. */
  const sso = async () => {
    const email = form.getValues('email');
    if (!z.email().safeParse(email).success) return form.setError('email', { message: 'Enter your work email first' });
    setSsoBusy(true);
    setError(null);
    try {
      const r = await api<{ sso: boolean; loginUrl?: string }>('/auth/sso/discover', { body: { email }, auth: false });
      if (r.sso && r.loginUrl) return window.location.assign(r.loginUrl);
      setError({ code: 'NO_SSO', message: 'Single sign-on is not set up for this email domain — use your password.' });
    } catch (err) {
      setError({ code: err instanceof ApiError ? err.code : 'UNKNOWN', message: errorMessage(err) });
    } finally {
      setSsoBusy(false);
    }
  };

  const resend = async () => {
    await api('/auth/verify-email/resend', { body: { email: form.getValues('email') }, auth: false }).catch(() => undefined);
    setResent(true);
  };

  if (mfaToken) {
    return (
      <AuthCard title="Two-factor authentication" description="Enter the code from your authenticator app, or one of your backup codes.">
        <form onSubmit={onCode} className="space-y-4" noValidate>
          <Field id="code" label="Verification code" inputMode="numeric" autoComplete="one-time-code" autoFocus registration={codeForm.register('code')} error={codeForm.formState.errors.code} />
          {error && <Alert tone="error">{error.message}</Alert>}
          <Button type="submit" className="w-full" loading={codeForm.formState.isSubmitting}>
            Verify
          </Button>
          <Button type="button" variant="link" className="w-full" onClick={() => setMfaToken(null)}>
            Use a different account
          </Button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back to Canon."
      footer={
        <>
          No account?{' '}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create one
          </Link>
        </>
      }
    >
      {ssoError && !error && <Alert tone="error" className="mb-4">{SSO_ERRORS[ssoError] ?? 'Single sign-on failed. Try again.'}</Alert>}
      <form onSubmit={onLogin} className="space-y-4" noValidate>
        <Field id="email" label="Email" type="email" autoComplete="email" autoFocus registration={form.register('email')} error={form.formState.errors.email} />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          registration={form.register('password')}
          error={form.formState.errors.password}
          hint={
            <Link href="/forgot-password" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          }
        />
        {error && (
          <Alert tone="error">
            {error.message}
            {error.code === 'SSO_REQUIRED' && error.loginUrl && (
              <div className="mt-2">
                <Button type="button" size="sm" onClick={() => window.location.assign(error.loginUrl!)}>
                  Continue with SSO
                </Button>
              </div>
            )}
            {error.code === 'EMAIL_NOT_VERIFIED' && (
              <div className="mt-2">
                {resent ? (
                  <span>New link sent — check your inbox.</span>
                ) : (
                  <Button type="button" variant="link" size="sm" onClick={resend}>
                    Resend verification email
                  </Button>
                )}
              </div>
            )}
          </Alert>
        )}
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
        <div className="relative py-1 text-center text-xs text-muted-foreground">
          <span className="bg-card px-2">or</span>
        </div>
        <Button type="button" variant="outline" className="w-full" loading={ssoBusy} onClick={() => void sso()}>
          Sign in with SSO
        </Button>
      </form>
    </AuthCard>
  );
}

/** Only same-app relative paths: an open redirect here would make phishing links look legitimate. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
