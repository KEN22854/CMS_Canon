import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

/**
 * Real screenshots of the running app for docs/CANON_2/screenshots (BEFORE/AFTER of each stage).
 * Opt-in: `SCREENSHOTS_DIR=../../docs/CANON_2/screenshots/after npx playwright test screenshots`.
 */
const OUT = process.env.SCREENSHOTS_DIR;
test.skip(!OUT, 'set SCREENSHOTS_DIR to capture screenshots');
test.setTimeout(300_000);

async function shot(page: Page, file: string) {
  const path = resolve(OUT!, file);
  mkdirSync(dirname(path), { recursive: true });
  // The builder keeps a co-editing WebSocket open, so network idle may never come.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path });
}

test('capture the main screens', async ({ page }) => {
  await signUp(page, { workspace: 'Northwind Studio' });
  await shot(page, join('dashboard', 'dashboard-desktop-1440.png'));
  const { siteId } = await createSite(page, 'Northwind');
  const site = `/sites/${siteId}`;

  await shot(page, join('dashboard', 'project-pages-desktop-1440.png'));
  await page.goto('/sites');
  await shot(page, join('dashboard', 'sites-desktop-1440.png'));

  // Builder
  await page.goto(`${site}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const canvas = page.getByRole('application', { name: 'Page canvas' });
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-desktop-1440.png'));
  const style = page.getByRole('button', { name: /^style$/i });
  if (await style.count()) {
    // A styled hero: the panel shows overrides, the canvas shows the result.
    await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
    await style.click();
    const field = (label: string) => page.getByLabel(label, { exact: true });
    await field('Padding top').fill('120');
    await field('Padding bottom').fill('120');
    await page.getByRole('button', { name: 'Background', exact: true, expanded: false }).click();
    await page.getByLabel('Gradient', { exact: true }).fill('linear-gradient(135deg, #8B7CFF, #42C8E8)');
    await page.getByRole('button', { name: 'Border', exact: true, expanded: false }).click();
    await field('Radius').fill('24px');
    await shot(page, join('builder', 'builder-style-panel-1440.png'));
  }
  await page.getByRole('button', { name: /^layers$/i }).click();
  await shot(page, join('builder', 'builder-layers-1440.png'));
  for (const [label, file] of [
    [/^Tablet/, 'builder-tablet-breakpoint-1440.png'],
    [/Mobile L/, 'builder-mobile-breakpoint-1440.png'],
  ] as const) {
    const bp = page.getByRole('radio', { name: label }).first();
    if (await bp.count()) {
      await bp.click();
      await shot(page, join('responsive', file));
    }
  }
  const desktop = page.getByRole('radio', { name: /^Desktop/ });
  if (await desktop.count()) await desktop.click();
  const builderUrl = page.url();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(builderUrl);
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-tablet-1024.png'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(builderUrl);
  await shot(page, join('builder', 'builder-mobile-390.png'));
  await page.setViewportSize({ width: 1440, height: 900 });

  // Light theme (dark is the default since Canon 2.0).
  await page.evaluate(() => localStorage.setItem('canon.theme', 'light'));
  await page.goto(builderUrl);
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-light-1440.png'));
  await page.goto('/');
  await shot(page, join('dashboard', 'dashboard-light-1440.png'));
  await page.evaluate(() => localStorage.setItem('canon.theme', 'dark'));

  // Content, growth, settings
  const screens: [string, string][] = [
    [`${site}/collections`, 'cms/cms-collections.png'],
    [`${site}/forms`, 'cms/forms.png'],
    [`${site}/reviews`, 'cms/reviews.png'],
    [`${site}/media`, 'cms/media.png'],
    [`${site}/search`, 'ai/search-and-answers.png'],
    ['/studio', 'ai/ai-studio.png'],
    ['/canon', 'ai/canon-facts.png'],
    [`${site}/analytics`, 'analytics/analytics-dashboard.png'],
    [`${site}/experiments`, 'analytics/ab-testing.png'],
    [`${site}/audiences`, 'analytics/audiences.png'],
    ['/settings/integrations', 'marketplace/integrations.png'],
    ['/settings/members', 'settings/team-management.png'],
    [`${site}/settings`, 'settings/site-settings.png'],
    ['/settings/billing', 'settings/billing.png'],
    ['/notifications', 'settings/notifications.png'],
  ];
  for (const [url, file] of screens) {
    await page.goto(url);
    await shot(page, file);
  }
});
