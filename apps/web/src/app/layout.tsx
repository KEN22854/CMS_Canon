import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  // <html lang> is set per page by the site layout via the locale segment.
  return (
    <html suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
