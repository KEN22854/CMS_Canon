import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

test('install a marketplace plugin and insert its block preset in the builder', async ({ page }) => {
  await signUp(page);
  await createSite(page, `E2E Plugins ${Date.now() % 100000}`);
  const editor = page.url();

  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: /Marketing blocks/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await expect(page.getByText('Marketing blocks installed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Installed' })).toBeVisible();

  await page.goto(editor);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const canvas = page.getByRole('application', { name: 'Page canvas' });
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Pricing tiers' }).click();
  await expect(canvas).toContainText('Simple, transparent pricing');
});

test('audit log records the work and the hash chain verifies', async ({ page }) => {
  await signUp(page);
  await createSite(page, `E2E Audit ${Date.now() % 100000}`);
  await page.goto('/settings/audit');
  await expect(page.getByRole('cell', { name: 'site.created' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify the chain' }).click();
  await expect(page.getByText(/Intact/)).toBeVisible();
});

test('billing shows plan usage; SSO is offered on Enterprise only', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings/billing');
  await expect(page.getByText('Usage this month')).toBeVisible();
  await expect(page.getByText('Current plan:')).toContainText('FREE');
  await page.goto('/settings/sso');
  await expect(page.getByText('SSO is part of the Enterprise plan')).toBeVisible();
});

test('login offers SSO discovery and explains when a domain has none', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('someone@no-sso-here.example');
  await page.getByRole('button', { name: 'Sign in with SSO' }).click();
  await expect(page.getByText('Single sign-on is not set up for this email domain')).toBeVisible();
});

test('site settings save and survive a reload', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E Settings ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/settings`);
  const renamed = `Renamed ${Date.now() % 100000}`;
  await page.getByLabel('Name', { exact: true }).fill(renamed);
  await page.getByLabel('Title template').fill('%s · E2E');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText('Saved — the live site refreshes within seconds').first()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(renamed);
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
});

test('the admin links to its source code (AGPL-3.0)', async ({ page }) => {
  await signUp(page);
  const link = page.getByRole('link', { name: /Source code · AGPL-3.0/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /github\.com\/KEN22854\/CMS_Canon/);
});
