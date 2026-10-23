import type { Config } from 'tailwindcss';
import sitePreset from '@canon/ui-blocks/tailwind-preset.cjs';

/** Site themes are CSS variables set per host at render time (see app/s/[host]/layout.tsx). */
export default {
  presets: [sitePreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui-blocks/src/**/*.{ts,tsx}'],
  plugins: [],
} satisfies Config;
