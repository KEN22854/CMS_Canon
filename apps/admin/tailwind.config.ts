import type { Config } from 'tailwindcss';
import sitePreset from '@canon/ui-blocks/tailwind-preset.cjs';

/** Colours are CSS variables (globals.css) so themes and per-site tokens swap without a rebuild. */
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  // The builder canvas renders real site blocks (site-* tokens, container queries).
  presets: [sitePreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui-blocks/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: token('background'),
        foreground: token('foreground'),
        muted: { DEFAULT: token('muted'), foreground: token('muted-foreground') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        secondary: { DEFAULT: token('secondary'), foreground: token('secondary-foreground') },
        destructive: { DEFAULT: token('destructive'), foreground: token('destructive-foreground') },
        accent: { DEFAULT: token('accent'), foreground: token('accent-foreground') },
        success: token('success'),
        warning: token('warning'),
        overlay: token('overlay'),
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'], mono: ['var(--font-mono)', 'monospace'] },
      boxShadow: { sm: 'var(--shadow-sm)', DEFAULT: 'var(--shadow-md)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)' },
      keyframes: { shimmer: { '100%': { transform: 'translateX(100%)' } } },
      animation: { shimmer: 'shimmer 1.4s infinite' },
    },
  },
  plugins: [],
} satisfies Config;
