import type { ReactNode } from 'react';
import { AppShell, AuthGate } from '@/components/app-shell';

export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
