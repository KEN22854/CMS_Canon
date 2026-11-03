import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

/** Screenshots of the block library per category (opt-in: SCREENSHOTS_DIR). */
const OUT = process.env.SCREENSHOTS_DIR;
test.skip(!OUT, 'set SCREENSHOTS_DIR to capture screenshots');
test.setTimeout(180_000);

async function shot(page: Page, file: string) {
  const path = resolve(OUT!, file);
  mkdirSync(dirname(path), { recursive: true });
  await page.waitForTimeout(1200); // stock photos load from their hosts
  await page.screenshot({ path });
}

test('capture the block library categories', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple', workspace: 'Northwind Studio' });
  const { siteId } = await createSite(page, 'Northwind');
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await page.getByRole('button', { name: 'Add block' }).click();
  const library = page.getByRole('dialog', { name: 'Block library' });
  await expect(library).toBeVisible();
  for (const [cat, file] of [
    [/^Hero/, 'library-hero'],
    [/^Features/, 'library-features'],
    [/^Shop/, 'library-shop'],
    [/^Header & footer/, 'library-navigation'],
    [/^Content/, 'library-content'],
  ] as const) {
    await library.getByRole('navigation').getByRole('button', { name: cat }).click();
    await expect(library.getByText(/Tailblocks · MIT|HyperUI · MIT/).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, `library/${file}-1440.png`);
  }
});
