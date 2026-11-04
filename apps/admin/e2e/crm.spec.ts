import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buyOnSite, createShop, createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';
const OUT = process.env.SCREENSHOTS_DIR;
async function shot(page: Page, file: string) {
  if (!OUT) return;
  const path = resolve(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path });
}

test.setTimeout(180_000);

test('CRM: an automation tags buyers, the order makes a contact with a timeline, the team adds a note', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E CRM ${Date.now() % 100000}`);
  await createShop(page, siteId);

  // When an order is placed → tag "buyer" and tell the team.
  await page.goto(`/sites/${siteId}/automations`);
  await expect(page.getByText('No automations yet.')).toBeVisible();
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Welcome buyers');
  await page.getByLabel('When', { exact: true }).selectOption('order.placed');
  await page.getByLabel('Then 1').selectOption('add_tag');
  await page.getByLabel('Tag', { exact: true }).fill('buyer');
  await page.getByRole('button', { name: 'Add action' }).click();
  await page.getByLabel('Then 2').selectOption('email_team');
  await page.getByLabel('To', { exact: true }).fill('team@e2e.test');
  await page.getByLabel('Subject').fill('New order #{{order.number}} from {{contact.name}}');
  await page.getByLabel('Text', { exact: true }).fill('{{contact.name}} ordered {{order.total}}.');
  await shot(page, 'crm/crm-automation-editor-1440.png');
  await page.getByRole('button', { name: 'Save automation' }).click();
  await expect(page.getByText('Automation saved')).toBeVisible();
  await expect(page.getByText('Welcome buyers')).toBeVisible();

  // A visitor buys.
  await buyOnSite(page, `http://${host}:${WEB_PORT}`, 'rye-loaf', 2);

  // The contact appears (events are processed in the background) with the tag and the order.
  await page.goto(`/sites/${siteId}/contacts`);
  // Refetch inside the page (a filter toggle), not by reloading: reloads mid-refresh would rotate the session away.
  const customersOnly = page.getByLabel('Customers only');
  await expect
    .poll(async () => {
      await customersOnly.click();
      await page.waitForTimeout(700);
      return page.getByRole('button', { name: 'Ada Buyer' }).count();
    }, { timeout: 30_000 })
    .toBe(1);
  await expect(page.getByRole('row', { name: /Ada Buyer/ })).toContainText('buyer');
  await expect(page.getByRole('row', { name: /Ada Buyer/ })).toContainText('€9.00');
  await page.getByRole('button', { name: 'Ada Buyer' }).click();
  const panel = page.getByRole('dialog', { name: 'Ada Buyer' });
  await expect(panel.getByText('Order #1001 — €9.00')).toBeVisible();
  await expect(panel.getByText(/Team notified: New order #1001 from Ada Buyer/)).toBeVisible();
  await panel.getByLabel('Add a note').fill('Prefers morning delivery.');
  await panel.getByRole('button', { name: 'Add note' }).click();
  await expect(panel.getByText('Prefers morning delivery.')).toBeVisible();
  await shot(page, 'crm/crm-contacts-1440.png');

  // The automation's history shows the run.
  await page.goto(`/sites/${siteId}/automations`);
  await expect(page.getByText(/Ran 1 times/)).toBeVisible();
  await page.getByRole('button', { name: 'Recent runs' }).click();
  await expect(page.getByText('done')).toBeVisible();
  await shot(page, 'crm/crm-automations-1440.png');
});
