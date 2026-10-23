import type { Config } from 'tailwindcss';

/** Site themes are CSS variables set per host at render time (see app/s/[host]/layout.tsx). */
const v = (name: string) => `rgb(var(--site-${name}) / <alpha-value>)`;

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { primary: v('primary'), background: v('background'), foreground: v('foreground'), muted: v('muted') },
      borderRadius: { site: 'var(--site-radius)' },
      fontFamily: { site: 'var(--site-font)' },
    },
  },
  plugins: [],
} satisfies Config;
