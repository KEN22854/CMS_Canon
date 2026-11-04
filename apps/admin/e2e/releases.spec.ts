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

test.setTimeout(150_000);

/** Retitles the home hero in the builder and publishes. */
async function publishHome(page: Page, siteId: string, title: string) {
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const h1 = page.getByRole('application', { name: 'Page canvas' }).locator('[data-block-type="hero"] h1').first();
  await h1.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(h1).toHaveText(title);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
}

test('releases: record the live site, publish a bad change, roll the whole site back', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Releases ${Date.now() % 100000}`);
  const site = `http://${host}:${WEB_PORT}/`;
  const liveHas = (text: string) => expect.poll(async () => (await (await request.get(site)).text()).includes(text), { timeout: 30_000 }).toBe(true);

  await publishHome(page, siteId, 'Fresh bread every morning');
  await liveHas('Fresh bread every morning');

  await page.goto(`/sites/${siteId}/releases`);
  await expect(page.getByText('No releases yet. Create one before a big change.')).toBeVisible();
  page.once('dialog', (d) => void d.accept('Launch'));
  await page.getByRole('button', { name: 'Create release' }).click();
  await expect(page.getByText('Release 1 recorded')).toBeVisible();
  await expect(page.getByText(/Launch · 1 pages/)).toBeVisible();

  // A bad change goes live…
  await publishHome(page, siteId, 'CLOSED FOREVER (oops)');
  await liveHas('CLOSED FOREVER (oops)');

  // …and the whole site goes back to release 1.
  await page.goto(`/sites/${siteId}/releases`);
  await page.getByRole('button', { name: 'Review and roll back' }).click();
  await expect(page.getByText('Back to the release version')).toBeVisible();
  await expect(page.getByText(/Home — \/ \(v\d+ → v\d+\)/)).toBeVisible();
  await shot(page, 'releases/releases-review-1440.png');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Roll the site back to release 1' }).click();
  await expect(page.getByText(/Site rolled back: 1 pages restored, 0 taken offline\. Undo with release 2\./)).toBeVisible();
  await liveHas('Fresh bread every morning');
  expect(await (await request.get(site)).text()).not.toContain('CLOSED FOREVER');
  await expect(page.getByText('Release 2 automatic')).toBeVisible();
  await shot(page, 'releases/releases-list-1440.png');
});
