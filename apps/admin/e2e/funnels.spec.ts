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

test('funnels: real visits on the live site show up step by step in the funnel', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Funnel ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();

  // The funnel: the home page, then a click on a call to action, in one visit.
  await page.goto(`/sites/${siteId}/analytics`);
  await page.getByRole('button', { name: 'New funnel' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Home → CTA');
  await page.getByLabel('Steps must happen').selectOption('session');
  await page.getByRole('button', { name: 'Save funnel' }).click();
  await expect(page.getByText('Funnel saved')).toBeVisible();

  // Two visitors on the live site: one clicks the CTA, one only looks.
  for (const clicks of [true, false]) {
    const ctx = await browser.newContext();
    const visitor = await ctx.newPage();
    await visitor.goto(`http://${host}:${WEB_PORT}/`);
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await visitor.waitForTimeout(500);
    if (clicks) await visitor.locator('[data-canon-event="cta_click"]').first().click({ noWaitAfter: true });
    await visitor.waitForTimeout(1500);
    await ctx.close(); // the tracker flushes on page hide
  }

  // Buffered events are written in batches; poll the report (a refetch, not a reload).
  const funnel = page.getByRole('region', { name: 'Home → CTA' });
  await expect
    .poll(async () => {
      await page.getByRole('radio', { name: /7/ }).first().click();
      await page.getByRole('radio', { name: /30/ }).first().click();
      await page.waitForTimeout(1000);
      return funnel.getByText('Converts 50%').count();
    }, { timeout: 60_000, intervals: [2000] })
    .toBe(1);
  await expect(funnel.getByRole('img', { name: /^\/: 2 visitors/ })).toBeVisible();
  await expect(funnel.getByRole('img', { name: /^cta_click: 1 visitors/ })).toBeVisible();
  await funnel.scrollIntoViewIfNeeded();
  await shot(page, 'analytics/funnels-1440.png');
});
