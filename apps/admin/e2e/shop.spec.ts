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

test('shop: a product collection, product page with Buy, cart and checkout on the site, the order in the admin', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Shop ${Date.now() % 100000}`);

  // Products from the preset, sold in EUR.
  await page.goto(`/sites/${siteId}/collections`);
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByRole('button', { name: /^Products/ }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Products', level: 2 })).toBeVisible();
  const listUrl = page.url();

  await page.getByRole('button', { name: 'Sell these entries' }).click();
  await expect(page.getByLabel('Price field')).toHaveValue('price');
  await expect(page.getByLabel('Stock field')).toHaveValue('stock');
  await page.getByLabel('Currency').selectOption('EUR');
  await page.getByLabel('Email for new orders').fill('shop@e2e.test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('A shop in EUR: price from “Price”, stock from “Stock”')).toBeVisible();
  await page.getByRole('button', { name: 'Create the cart page' }).click();
  await expect(page.getByText('The cart page is live at /cart')).toBeVisible();

  // Product pages at /products/<slug>, from a template that includes the Buy block.
  await page.getByRole('button', { name: 'Entry pages' }).click();
  await page.getByRole('button', { name: 'Create and publish a template' }).click();
  await expect(page.getByLabel('Template page')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Every published entry is a page at /products/…')).toBeVisible();

  // One product with two in stock, published in bulk.
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.locator('#fld-name').fill('Rye loaf');
  await page.locator('#fld-price').fill('4.5');
  await page.locator('#fld-stock').fill('2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Saved · v\d/)).toBeVisible();
  await page.goto(listUrl);
  await page.getByLabel('Select all entries on this page').check();
  await page.getByRole('toolbar').getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Done: 1')).toBeVisible();
  await shot(page, 'shop/shop-collection-1440.png');

  // The visitor: product page → Add to cart → cart → order.
  const site = `http://${host}:${WEB_PORT}`;
  await expect.poll(async () => (await request.get(`${site}/products/rye-loaf`)).status(), { timeout: 30_000 }).toBe(200);
  await page.goto(`${site}/products/rye-loaf`);
  await expect(page.getByRole('heading', { name: 'Rye loaf', level: 1 })).toBeVisible();
  await expect(page.getByText('€4.50')).toBeVisible();
  await expect(page.getByText('2 in stock')).toBeVisible();
  await expect(page.getByRole('link', { name: /entry template/ })).toHaveCount(0); // templates aren't menu items
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByRole('status')).toContainText('Added to cart');
  await shot(page, 'shop/shop-product-1440.png');
  await page.getByRole('link', { name: 'Open cart' }).click();
  await expect(page.getByLabel('Quantity of Rye loaf')).toHaveValue('1');
  await expect(page.getByText('Your cart is empty.')).toBeHidden();
  await page.getByLabel('Quantity of Rye loaf').fill('2');
  await page.getByLabel('Name').fill('Ada Buyer');
  await page.getByLabel('Email').fill('ada@e2e.test');
  await page.getByLabel('Delivery address').fill('1 Bread Street');
  await page.getByLabel('Bank transfer').check();
  await shot(page, 'shop/shop-cart-1440.png');
  // Checkout refuses forms filled faster than a person could (a bot); behave like one.
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Place order/ }).click();
  await expect(page.getByText('Order #1001')).toBeVisible();
  await expect(page.getByText('Total: €9.00')).toBeVisible();

  // Sold out now (the product page reflects the stock).
  await expect.poll(async () => (await (await request.get(`${site}/products/rye-loaf`)).text()).includes('Sold out'), { timeout: 30_000 }).toBe(true);

  // The shop owner: the order in Orders, confirmed.
  await page.goto(`/sites/${siteId}/orders`);
  await expect(page.getByRole('button', { name: '#1001' })).toBeVisible();
  await page.getByRole('button', { name: '#1001' }).click();
  const panel = page.getByRole('dialog', { name: 'Order #1001' });
  await expect(panel.getByText('Ada Buyer')).toBeVisible();
  await expect(panel.getByText('2 × Rye loaf')).toBeVisible();
  await expect(panel.getByText('Bank transfer')).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Order #1001: Confirmed')).toBeVisible();
  await shot(page, 'shop/shop-orders-1440.png');
});
