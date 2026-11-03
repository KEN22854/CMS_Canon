import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';

async function openHome(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
}

const heroPaddingTop = (page: Page) => page.locator('[data-block-type="hero"]').first().evaluate((el) => getComputedStyle(el).paddingTop);

test('style a block per breakpoint, keep it after reload, and publish it', async ({ page, request }) => {
  await signUp(page);
  const { siteId, host } = await createSite(page, `E2E Builder ${Date.now() % 100000}`);
  await openHome(page, siteId);

  // Select the hero and give it a desktop padding.
  await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await expect(page.getByText('Editing Desktop')).toBeVisible();
  await page.getByLabel('Padding top', { exact: true }).fill('96');
  await expect.poll(() => heroPaddingTop(page)).toBe('96px');

  // Mobile L overrides only mobile; desktop keeps 96px.
  await page.getByRole('radio', { name: /Mobile L/ }).click();
  await expect(page.getByText('Editing Mobile L')).toBeVisible();
  await expect(page.getByLabel('Padding top', { exact: true })).toHaveAttribute('placeholder', '96px');
  await page.getByLabel('Padding top', { exact: true }).fill('24px');
  await expect.poll(() => heroPaddingTop(page)).toBe('24px');
  await page.getByRole('radio', { name: /^Desktop/ }).click();
  await expect.poll(() => heroPaddingTop(page)).toBe('96px');

  // Invalid values are flagged and never applied.
  await page.getByLabel('Padding top', { exact: true }).fill('96px;color:red');
  await expect(page.getByLabel('Padding top', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Padding top', { exact: true }).fill('96px');

  // Layers: rename and hide the second section.
  await page.getByRole('button', { name: /^layers$/i }).click();
  const hero = page.getByRole('treeitem', { name: 'Hero' }).first();
  await hero.locator('[data-layer-id]').first().dblclick();
  await page.getByLabel('Layer name').fill('Main hero');
  await page.getByLabel('Layer name').press('Enter');
  await expect(page.getByRole('treeitem', { name: 'Main hero' })).toBeVisible();
  const second = page.locator('[role="tree"] > [role="treeitem"]').nth(1);
  const secondName = (await second.getAttribute('aria-label'))!;
  await second.locator('[data-layer-id]').first().hover();
  await page.getByRole('button', { name: `Hide ${secondName}` }).click();
  await expect(page.locator('[data-hidden]')).toHaveCount(1);

  // Save, reload: styles, name and visibility come back from the server.
  await page.keyboard.press('Control+s');
  // The toast appears only once the server acknowledged the save.
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await expect.poll(() => heroPaddingTop(page)).toBe('96px');
  await expect(page.locator('[data-hidden]')).toHaveCount(1);
  await page.getByRole('button', { name: /^layers$/i }).click();
  await expect(page.getByRole('treeitem', { name: 'Main hero' })).toBeVisible();

  // Publish: the live page carries the compiled styles and drops the hidden section.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  await expect
    .poll(async () => {
      const res = await request.get(`http://${host}:${WEB_PORT}/`).catch(() => null);
      return res ? await res.text() : '';
    }, { timeout: 30_000 })
    .toContain('padding-top:96px');
  const html = await (await request.get(`http://${host}:${WEB_PORT}/`)).text();
  expect(html).toContain('@container (max-width: 767px)');
  expect(html).toContain('padding-top:24px');
});

test('zoom the canvas and lock a block against deletion', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E Zoom ${Date.now() % 100000}`);
  await openHome(page, siteId);
  // Desktop renders at 1280 px and is scaled to fit; zoom scales on top of the fit.
  const zoomLabel = page.getByRole('button', { name: 'Reset zoom to 100%' });
  const pct = async () => Number((await zoomLabel.textContent())!.replace('%', ''));
  const fitted = await pct();
  expect(fitted).toBeLessThanOrEqual(100);
  await expect(page.getByLabel('Viewport')).toContainText('Desktop · 1280 px');
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(pct).toBeLessThan(fitted);
  await zoomLabel.click();
  await expect.poll(pct).toBe(fitted);
  await page.getByRole('radio', { name: /Mobile S/ }).click();
  await expect(page.getByLabel('Viewport')).toContainText('Mobile S · 375 px');
  await expect.poll(pct).toBe(100);

  await page.getByRole('button', { name: /^layers$/i }).click();
  const first = page.locator('[role="tree"] > [role="treeitem"]').first();
  const name = (await first.getAttribute('aria-label'))!;
  const count = await page.locator('[role="tree"] > [role="treeitem"]').count();
  await first.locator('[data-layer-id]').first().click();
  await page.getByRole('button', { name: `Lock ${name}` }).click();
  await expect(page.getByRole('button', { name: `Delete ${name}` })).toBeDisabled();
  await page.keyboard.press('Delete');
  await expect(page.locator('[role="tree"] > [role="treeitem"]')).toHaveCount(count);
  await page.getByRole('button', { name: `Unlock ${name}` }).click();
  await page.getByRole('button', { name: `Delete ${name}` }).click();
  await expect(page.locator('[role="tree"] > [role="treeitem"]')).toHaveCount(count - 1);
});
