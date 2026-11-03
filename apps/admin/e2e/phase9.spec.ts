import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

test('build a form from a template and see its empty inbox', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E Forms ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/forms`);
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Name').fill('Contact sales');
  await page.getByLabel('Start from').selectOption({ label: 'Demo request' });
  await page.getByRole('button', { name: 'Create form' }).click();

  await expect(page).toHaveURL(/\/forms\/[^/]+\?tab=fields$/);
  await expect(page.getByRole('heading', { name: 'Contact sales' })).toBeVisible();
  await expect(page.getByLabel('Label').first()).toHaveValue('Full name');
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('Fields saved')).toBeVisible();

  await page.getByRole('tab', { name: 'Submissions' }).click();
  await expect(page.getByText('No submissions yet')).toBeVisible();
  await page.goto(`/sites/${siteId}/forms`);
  await expect(page.getByText('7 fields')).toBeVisible();
});

test('switch the interface to Russian and keep it after a reload', async ({ page }) => {
  await signUp(page);
  await page.getByLabel('Language').selectOption('ru');
  await expect(
    page.getByRole('navigation', { name: 'Основное' }).getByRole('link', { name: 'Сайты' }),
  ).toBeVisible();
  await expect(page.getByText('Использование тарифа')).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'Основное' }).getByRole('link', { name: 'Сайты' }),
  ).toBeVisible();
  await page.getByLabel('Язык').selectOption('en');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sites' }),
  ).toBeVisible();
});

test('a site that requires review blocks publishing until an owner overrides', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E Review ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/settings`);
  await page.getByLabel(/Require review before publishing/).check();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText(/Saved/).first()).toBeVisible();

  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  // The owner is offered an audited override; declining keeps the page unpublished.
  page.once('dialog', (d) => void d.dismiss());
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    page.getByText('This site requires an approved review before publishing').first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask for review' })).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
});
