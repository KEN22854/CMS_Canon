import type { CSSProperties, ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { resolveSite, type SiteTheme } from '@/lib/delivery';

const FONTS: Record<SiteTheme['font'], string> = {
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  Inter: "Inter, ui-sans-serif, system-ui, sans-serif",
  Manrope: "Manrope, ui-sans-serif, system-ui, sans-serif",
  Lora: "Lora, ui-serif, Georgia, serif",
};
const RADIUS: Record<SiteTheme['radius'], string> = { none: '0', sm: '0.25rem', md: '0.5rem', lg: '1rem', full: '9999px' };

/** "#4f46e5" → "79 70 229" so Tailwind's <alpha-value> works with theme colours. */
function rgb(hex: string | undefined, fallback: string): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ host: string }> }) {
  const { host } = await params;
  const site = await resolveSite(decodeURIComponent(host));
  if (!site) notFound();
  const t = site.theme;
  const style = {
    '--site-primary': rgb(t.colors?.primary, '79 70 229'),
    '--site-background': rgb(t.colors?.background, '255 255 255'),
    '--site-foreground': rgb(t.colors?.foreground, '15 23 42'),
    '--site-muted': rgb(t.colors?.muted, '241 245 249'),
    '--site-radius': RADIUS[t.radius] ?? RADIUS.md,
    '--site-font': FONTS[t.font] ?? FONTS.system,
  } as CSSProperties;
  return (
    <div style={style} className="min-h-screen bg-background font-site text-foreground">
      {children}
    </div>
  );
}
