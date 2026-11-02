import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';

test('sign up, build a page, publish it, and see it on the live site', async ({ page }) => {
  await signUp(page);
  const { host } = await createSite(page, `E2E Shop ${Date.now() % 100000}`);

  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();

  // Select the hero by clicking its heading on the canvas, then edit it in the inspector.
  const title = `Launch ${Date.now()}`;
  await page.getByRole('application', { name: 'Page canvas' }).locator('[data-block-id] h1').first().click();
  const field = page.getByLabel('Title', { exact: true });
  await field.fill(title);
  await expect(page.getByRole('application', { name: 'Page canvas' })).toContainText(title);
  await expect(page.getByText(/Saved · v\d+/)).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/Published/)).toBeVisible();

  // The renderer serves the site by host name; on-demand revalidation makes it fresh immediately.
  await expect(async () => {
    const res = await page.request.get(`http://${host}:${WEB_PORT}/`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(title);
  }).toPass({ timeout: 30_000 });
});

test('undo and redo in the builder restore the previous text', async ({ page }) => {
  await signUp(page);
  await createSite(page, `E2E Undo ${Date.now() % 100000}`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const canvas = page.getByRole('application', { name: 'Page canvas' });
  const hero = canvas.locator('[data-block-id] h1').first();
  const original = (await hero.textContent())!;
  await hero.click();
  await page.getByLabel('Title', { exact: true }).fill('Temporary headline');
  await expect(canvas).toContainText('Temporary headline');
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(hero).toHaveText(original);
  await page.getByRole('button', { name: /Redo/ }).click();
  await expect(hero).toHaveText('Temporary headline');
});
