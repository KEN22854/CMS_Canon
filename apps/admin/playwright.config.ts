import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running stack (API :4000, admin :3000, renderer :3001, Mailpit :8035).
 * Locally: `pnpm infra:up && pnpm db:migrate && pnpm dev`, then `pnpm --filter @canon/admin e2e`.
 * CI starts the same stack before running them (see .github/workflows/ci.yml).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_ADMIN_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
