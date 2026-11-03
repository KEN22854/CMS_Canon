import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Canon', template: '%s · Canon' },
  description: 'AI-native headless CMS',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
