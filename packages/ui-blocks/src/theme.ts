import type { CSSProperties } from 'react';

/** The subset of a site theme the renderers depend on. Unknown/missing values fall back to defaults. */
export interface SiteThemeInput {
  colors?: Partial<Record<'primary' | 'background' | 'foreground' | 'muted', string>>;
  font?: string;
  radius?: string;
}

const FONTS: Record<string, string> = {
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  Inter: 'Inter, ui-sans-serif, system-ui, sans-serif',
  Manrope: 'Manrope, ui-sans-serif, system-ui, sans-serif',
  Lora: 'Lora, ui-serif, Georgia, serif',
};
const RADIUS: Record<string, string> = { none: '0', sm: '0.25rem', md: '0.5rem', lg: '1rem', full: '9999px' };

/** "#4f46e5" → "79 70 229" so Tailwind's <alpha-value> works with theme colours. */
export function hexToRgbChannels(hex: string | undefined, fallback: string): string {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * CSS custom properties consumed by the `site-*` Tailwind tokens (see tailwind-preset.cjs). The
 * public renderer sets them per host; the builder canvas sets them per edited site, so both paint
 * a page identically.
 */
/**
 * Text on the primary colour: white unless the primary is light (then near-black) — whichever has
 * the higher WCAG contrast, so a pale primary in a dark theme still gets readable buttons.
 */
export function onPrimaryChannels(hex: string | undefined): string {
  const rgb = hexToRgbChannels(hex, '79 70 229').split(' ').map(Number);
  const lum = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * lum[0]! + 0.7152 * lum[1]! + 0.0722 * lum[2]!;
  // Contrast with white is 1.05/(l+0.05); with #0f172a (l≈0.0087) it is (l+0.05)/0.0587.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0587 ? '255 255 255' : '15 23 42';
}

export function siteThemeStyle(t: SiteThemeInput | undefined): CSSProperties {
  return {
    '--site-primary': hexToRgbChannels(t?.colors?.primary, '79 70 229'),
    '--site-on-primary': onPrimaryChannels(t?.colors?.primary),
    '--site-background': hexToRgbChannels(t?.colors?.background, '255 255 255'),
    '--site-foreground': hexToRgbChannels(t?.colors?.foreground, '15 23 42'),
    '--site-muted': hexToRgbChannels(t?.colors?.muted, '241 245 249'),
    '--site-radius': RADIUS[t?.radius ?? 'md'] ?? RADIUS.md,
    '--site-font': FONTS[t?.font ?? 'system'] ?? FONTS.system,
  } as CSSProperties;
}
