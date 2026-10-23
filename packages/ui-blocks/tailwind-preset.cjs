/**
 * Tailwind preset shared by apps/web and the admin builder canvas. Site colours live under the
 * `site-*` namespace so they never collide with the admin's own design tokens, and responsiveness
 * uses container queries (`@3xl:` …) so the canvas can preview breakpoints without resizing the window.
 *
 * Consumers must also add `../../packages/ui-blocks/src/**\/*.{ts,tsx}` to their `content`.
 */
const v = (name) => `rgb(var(--site-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [],
  theme: {
    extend: {
      colors: { site: { primary: v('primary'), bg: v('background'), fg: v('foreground'), muted: v('muted') } },
      borderRadius: { site: 'var(--site-radius)' },
      fontFamily: { site: 'var(--site-font)' },
    },
  },
  plugins: [require('@tailwindcss/container-queries')],
};
