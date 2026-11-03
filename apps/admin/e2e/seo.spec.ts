import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';

test('redirects, the SEO audit, structured data and the site 404 on the live renderer', async ({ page, request }) => {
  await signUp(page);
  const { siteId, host } = await createSite(page, `E2E SEO ${Date.now() % 100000}`);
  const live = (path: string) => `http://${host}:${WEB_PORT}${path}`;

  // A redirect typed in the SEO screen reaches the renderer: 301 with the query string kept.
  await page.goto(`/sites/${siteId}/seo?tab=redirects`);
  await page.getByLabel('From', { exact: true }).fill('/old-home');
  await page.getByLabel('To', { exact: true }).fill('/');
  await page.getByRole('button', { name: 'Add redirect' }).click();
  await expect(page.getByText('Redirect added')).toBeVisible();
  await expect(page.locator('code', { hasText: '/old-home' })).toBeVisible();
  await expect
    .poll(async () => (await request.get(live('/old-home?utm_source=mail'), { maxRedirects: 0 }).catch(() => null))?.status() ?? 0, { timeout: 45_000 })
    .toBe(301);
  const res = await request.get(live('/old-home?utm_source=mail'), { maxRedirects: 0 });
  expect(new URL(res.headers().location!).pathname + new URL(res.headers().location!).search).toBe('/?utm_source=mail');

  // CSV import with a bad line reported.
  await page.getByLabel('Import from CSV').fill('from,to\n/a,/b\n/c,/c');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Imported 1 redirect(s)')).toBeVisible();
  await expect(page.getByText(/Line 3: Source and target are the same/)).toBeVisible();

  // The audit lists every page with a score; the home page links to /pricing, which doesn't exist.
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByLabel('SEO score')).toBeVisible();
  await expect(page.getByText('Home').first()).toBeVisible();

  // Publish the home page: JSON-LD (Organization, WebSite) is in the live HTML.
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  await expect.poll(async () => (await (await request.get(live('/'))).text()).includes('"@type":"WebSite"'), { timeout: 30_000 }).toBe(true);
  const html = await (await request.get(live('/'))).text();
  expect(html).toContain('application/ld+json');
  expect(html).toContain('"@type":"Organization"');

  // An unknown address gets the default 404 with the right status.
  const missing = await request.get(live('/definitely-not-here'));
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('Page not found');

  // The site's own 404: a published page at /404 replaces the default message; the status stays 404.
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('button', { name: /New page/ }).click();
  await page.locator('#new-title').fill('Lost');
  await page.locator('#new-slug').fill('404');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'Hero · centered' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  const visitor = await page.context().newPage();
  await expect(async () => {
    const r = await visitor.goto(live('/still-not-here'));
    expect(r!.status()).toBe(404);
    await expect(visitor.getByRole('heading', { name: 'Launch your next idea faster' })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await visitor.close();
});
