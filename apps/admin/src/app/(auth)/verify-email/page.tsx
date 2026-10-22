'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/auth-form';
import { Alert } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth, type AuthPayload } from '@/lib/auth-store';

function Verify() {
  const token = useSearchParams().get('token');
  const router = useRouter();
  const setSession = useAuth((s) => s.setSession);
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its token.');
  // Strict-mode double effects would spend the single-use token twice and show a false error.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api<AuthPayload>('/auth/verify-email', { body: { token }, auth: false })
      .then((res) => {
        setSession(res);
        router.replace('/');
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [token, router, setSession]);

  return (
    <AuthCard title="Confirming your email">
      {error ? (
        <>
          <Alert tone="error">{error}</Alert>
          <p className="text-sm text-muted-foreground">
            You can request a new link from the{' '}
            <Link className="text-primary hover:underline" href="/login">
              sign-in page
            </Link>
            .
          </p>
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Verifying…
        </div>
      )}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
