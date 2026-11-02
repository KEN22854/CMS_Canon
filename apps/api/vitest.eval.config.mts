import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Prompt evaluations against real models (pnpm --filter @canon/api eval). Not part of CI by default. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['evals/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 30 * 60_000,
    hookTimeout: 120_000,
    // The report is the output: print it as it is produced.
    disableConsoleIntercept: true,
  },
});
