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

test('CMS 2.0: entry pages from a template, bulk publish, filters and saved views, a collection list on the home page', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E CMS ${Date.now() % 100000}`);

  // A blog collection from the preset.
  await page.goto(`/sites/${siteId}/collections`);
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Blog');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Blog', level: 2 })).toBeVisible();
  const listUrl = page.url();

  // Entry pages: /blog/<slug>, from a template created (with tokens) and published in one click.
  await page.getByRole('button', { name: 'Entry pages' }).click();
  await expect(page.getByLabel('Address')).toHaveValue('/blog');
  await page.getByRole('button', { name: 'Create and publish a template' }).click();
  await expect(page.getByLabel('Template page')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Every published entry is a page at /blog/…')).toBeVisible();

  // Three drafts.
  for (const [title, excerpt] of [['Rye bread', 'Dark and dense'], ['Sourdough basics', 'Starter, flour, time'], ['Focaccia', 'Olive oil and salt']] as const) {
    await page.getByRole('button', { name: 'New entry' }).click();
    await page.locator('#fld-title').fill(title);
    await page.locator('#fld-excerpt').fill(excerpt);
    await page.locator('#fld-body').click();
    await page.keyboard.type(`How to bake ${title.toLowerCase()} at home.`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Saved · v\d/)).toBeVisible();
    await page.goto(listUrl);
  }
  await expect(page.getByRole('row')).toHaveCount(4);

  // Field filter + saved view.
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByLabel('Field', { exact: true }).selectOption({ label: 'Excerpt' });
  await page.getByLabel('Condition').selectOption('contains');
  await page.getByLabel('Value', { exact: true }).fill('salt');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Focaccia' })).toBeVisible();
  page.once('dialog', (d) => void d.accept('Salty'));
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('button', { name: 'Salty', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'All entries' }).click();
  await expect(page.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Salty', exact: true }).click();
  await expect(page.getByRole('row')).toHaveCount(2);
  await page.getByRole('button', { name: 'All entries' }).click();

  // Bulk: select all three, publish, tag.
  await page.getByLabel('Select all entries on this page').check();
  await expect(page.getByRole('toolbar', { name: '3 selected' })).toBeVisible();
  await shot(page, 'cms/cms2-entries-bulk-1440.png');
  await page.getByRole('toolbar').getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Done: 3')).toBeVisible();
  await expect(page.getByRole('cell').getByText('published', { exact: true })).toHaveCount(3);

  // The entry page is live, built from the template with the entry's values.
  await expect.poll(async () => (await request.get(`http://${host}:${WEB_PORT}/blog/focaccia`)).status(), { timeout: 30_000 }).toBe(200);
  const entryHtml = await (await request.get(`http://${host}:${WEB_PORT}/blog/focaccia`)).text();
  expect(entryHtml).toContain('<h1');
  expect(entryHtml).toContain('Focaccia');
  expect(entryHtml).toContain('Olive oil and salt');
  expect(entryHtml).toContain('How to bake focaccia at home.');
  expect(entryHtml).not.toContain('{{entry.');
  const sitemap = await (await request.get(`http://${host}:${WEB_PORT}/sitemap.xml`)).text();
  expect(sitemap).toContain('/blog/rye-bread');
  expect(sitemap).not.toContain('blog-template');

  // A Collection list on the home page: real cards in the builder, links on the site.
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const canvas = page.getByRole('application', { name: 'Page canvas' });
  await expect(canvas).toBeVisible();
  await page.getByRole('button', { name: 'Add block' }).click();
  const library = page.getByRole('dialog', { name: 'Block library' });
  await library.getByRole('button', { name: /^Basic blocks/ }).click();
  await library.getByRole('button', { name: 'Insert Collection list' }).click();
  await expect(canvas.getByText('Choose a collection in the inspector')).toBeVisible();
  const list = canvas.locator('[data-block-type="collection-list"]');
  await list.hover();
  await page.getByRole('button', { name: 'Content' }).first().click();
  await page.getByLabel('Collection', { exact: true }).selectOption({ label: 'Blog' });
  await expect(list.getByText('Sourdough basics')).toBeVisible();
  await expect(list.locator('li')).toHaveCount(3);
  await list.scrollIntoViewIfNeeded();
  await shot(page, 'cms/cms2-collection-list-builder-1440.png');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  await expect.poll(async () => (await (await request.get(`http://${host}:${WEB_PORT}/`)).text()).includes('href="/blog/rye-bread"'), { timeout: 30_000 }).toBe(true);
});
