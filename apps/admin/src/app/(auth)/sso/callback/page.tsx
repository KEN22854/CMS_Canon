'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AuthCard } from '@/components/auth-form';
import { Alert } from '@/components/ui';
import { refreshSession } from '@/lib/api';

/**
 * Landing page after the identity provider: the API has set the refresh cookie, and this
 * same-site request exchanges it for an access token (the cookie is SameSite=Strict, which the
 * cross-site IdP redirect itself could not carry).
 */
export default function SsoCallback() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void refreshSession().then((ok) => (ok ? router.replace('/') : setFailed(true)));
  }, [router]);
  return (
    <AuthCard title="Signing you in…" description="Finishing single sign-on.">
      {failed ? <Alert tone="error">The session could not be started. <a href="/login" className="underline">Back to sign in</a></Alert> : <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />}
    </AuthCard>
  );
}
