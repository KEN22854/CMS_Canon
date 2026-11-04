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

test('themes: pick a preset from the gallery, save it to the site and the workspace, the live site repaints', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Themes ${Date.now() % 100000}`);

  // Publish the home page so there is something to repaint.
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();

  await page.goto(`/sites/${siteId}/settings`);
  await page.getByRole('button', { name: 'Nature', exact: true }).click();
  await page.getByRole('button', { name: 'Try “Forest”' }).click();
  await expect(page.getByRole('button', { name: 'Try “Forest”' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Not saved yet')).toBeVisible();
  await expect(page.getByLabel('Primary')).toHaveValue('#15803d');
  await expect(page.getByLabel('Font')).toHaveValue('Manrope');
  await page.getByRole('region', { name: 'Theme gallery' }).scrollIntoViewIfNeeded();
  await shot(page, 'themes/themes-gallery-1440.png');

  // A low-contrast colour is flagged before it is saved.
  await page.getByLabel('Text', { exact: true }).fill('#cccccc');
  await expect(page.getByText(/Hard to read: text on the background/)).toBeVisible();
  await page.getByRole('button', { name: 'Try “Forest”' }).click();
  await expect(page.getByText(/Hard to read/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Save theme' }).click();
  await expect(page.getByText('Theme saved — the live site refreshes within seconds')).toBeVisible();
  // #15803d = rgb(21 128 61); a dark primary gets white button text.
  await expect.poll(async () => (await (await request.get(`http://${host}:${WEB_PORT}/`)).text()).includes('--site-primary:21 128 61'), { timeout: 30_000 }).toBe(true);
  expect(await (await request.get(`http://${host}:${WEB_PORT}/`)).text()).toContain('--site-on-primary:255 255 255');

  // Saved for the workspace: it shows up under Workspace themes.
  page.once('dialog', (d) => void d.accept('Bakery green'));
  await page.getByRole('button', { name: 'Save to workspace' }).click();
  await expect(page.getByText('Saved as “Bakery green”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try “Bakery green”' })).toBeVisible();
});
