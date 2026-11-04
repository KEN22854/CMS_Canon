import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';
const OUT = process.env.SCREENSHOTS_DIR;
async function shot(page: Page, file: string) {
  if (!OUT) return;
  const path = resolve(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path });
}

test.setTimeout(120_000);

test('migration center: a WordPress export becomes a blog with entry pages, pages and redirects', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Import ${Date.now() % 100000}`);

  await page.goto(`/sites/${siteId}/migration`);
  await page.getByLabel('Choose the export file').setInputFiles(resolve(__dirname, 'fixtures/wordpress-export.xml'));
  const report = page.getByRole('region', { name: 'What will be imported from “Old Bakery Blog”' });
  await expect(report).toBeVisible();
  await expect(report.getByText('Posts: 1 (1 published, 0 drafts)')).toBeVisible();
  await expect(report.getByText('Pages: 1 (1 published, 0 drafts)')).toBeVisible();
  await expect(report.getByText('/2024/05/rye-and-patience → /blog/rye-and-patience')).toBeVisible();
  await shot(page, 'migration/migration-report-1440.png');

  await report.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Imported: 1 posts, 1 pages, 1 redirects')).toBeVisible();

  const site = `http://${host}:${WEB_PORT}`;
  await expect.poll(async () => (await request.get(`${site}/blog/rye-and-patience`)).status(), { timeout: 30_000 }).toBe(200);
  const post = await (await request.get(`${site}/blog/rye-and-patience`)).text();
  expect(post).toContain('Rye and patience');
  expect(post).toContain('<strong>time</strong>');
  expect(post).toContain('Mix the starter');
  expect(await (await request.get(`${site}/our-story`)).text()).toContain('Now we bake for the whole street.');
  // The old WordPress address still works.
  const old = await request.get(`${site}/2024/05/rye-and-patience`, { maxRedirects: 0 });
  expect(old.status()).toBe(301);
  expect(old.headers().location).toMatch(/\/blog\/rye-and-patience$/);
});
