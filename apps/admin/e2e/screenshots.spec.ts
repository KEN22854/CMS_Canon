import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

/**
 * Real screenshots of the running app for docs/CANON_2/screenshots (BEFORE/AFTER of each stage).
 * Opt-in: `SCREENSHOTS_DIR=../../docs/CANON_2/screenshots/after npx playwright test screenshots`.
 */
const OUT = process.env.SCREENSHOTS_DIR;
test.skip(!OUT, 'set SCREENSHOTS_DIR to capture screenshots');
test.setTimeout(300_000);

async function shot(page: Page, file: string) {
  const path = resolve(OUT!, file);
  mkdirSync(dirname(path), { recursive: true });
  // The builder keeps a co-editing WebSocket open, so network idle may never come.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path });
}

test('capture the main screens', async ({ page }) => {
  await signUp(page, { workspace: 'Northwind Studio' });
  await shot(page, join('dashboard', 'dashboard-desktop-1440.png'));
  const { siteId } = await createSite(page, 'Northwind');
  const site = `/sites/${siteId}`;

  await shot(page, join('dashboard', 'project-pages-desktop-1440.png'));
  await page.goto('/sites');
  await shot(page, join('dashboard', 'sites-desktop-1440.png'));

  // Builder
  await page.goto(`${site}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const canvas = page.getByRole('application', { name: 'Page canvas' });
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-desktop-1440.png'));
  const style = page.getByRole('button', { name: /^style$/i });
  if (await style.count()) {
    // A styled hero: the panel shows overrides, the canvas shows the result.
    await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
    await style.click();
    const field = (label: string) => page.getByLabel(label, { exact: true });
    await field('Padding top').fill('120');
    await field('Padding bottom').fill('120');
    await page.getByRole('button', { name: 'Background', exact: true, expanded: false }).click();
    await page.getByLabel('Gradient', { exact: true }).fill('linear-gradient(135deg, #8B7CFF, #42C8E8)');
    await page.getByRole('button', { name: 'Border', exact: true, expanded: false }).click();
    await field('Radius').fill('24px');
    await shot(page, join('builder', 'builder-style-panel-1440.png'));
  }
  await page.getByRole('button', { name: /^layers$/i }).click();
  await shot(page, join('builder', 'builder-layers-1440.png'));
  for (const [label, file] of [
    [/^Tablet/, 'builder-tablet-breakpoint-1440.png'],
    [/Mobile L/, 'builder-mobile-breakpoint-1440.png'],
  ] as const) {
    const bp = page.getByRole('radio', { name: label }).first();
    if (await bp.count()) {
      await bp.click();
      await shot(page, join('responsive', file));
    }
  }
  const desktop = page.getByRole('radio', { name: /^Desktop/ });
  if (await desktop.count()) await desktop.click();
  const builderUrl = page.url();
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(builderUrl);
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-tablet-1024.png'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(builderUrl);
  await shot(page, join('builder', 'builder-mobile-390.png'));
  await page.setViewportSize({ width: 1440, height: 900 });

  // Light theme (dark is the default since Canon 2.0).
  await page.evaluate(() => localStorage.setItem('canon.theme', 'light'));
  await page.goto(builderUrl);
  await expect(canvas).toBeVisible();
  await shot(page, join('builder', 'builder-light-1440.png'));
  await page.goto('/');
  await shot(page, join('dashboard', 'dashboard-light-1440.png'));
  await page.evaluate(() => localStorage.setItem('canon.theme', 'dark'));

  // Content, growth, settings
  const screens: [string, string][] = [
    [`${site}/collections`, 'cms/cms-collections.png'],
    [`${site}/forms`, 'cms/forms.png'],
    [`${site}/reviews`, 'cms/reviews.png'],
    [`${site}/media`, 'cms/media.png'],
    [`${site}/search`, 'ai/search-and-answers.png'],
    ['/studio', 'ai/ai-studio.png'],
    ['/canon', 'ai/canon-facts.png'],
    [`${site}/analytics`, 'analytics/analytics-dashboard.png'],
    [`${site}/experiments`, 'analytics/ab-testing.png'],
    [`${site}/audiences`, 'analytics/audiences.png'],
    ['/settings/integrations', 'marketplace/integrations.png'],
    ['/settings/members', 'settings/team-management.png'],
    [`${site}/settings`, 'settings/site-settings.png'],
    ['/settings/billing', 'settings/billing.png'],
    ['/notifications', 'settings/notifications.png'],
  ];
  for (const [url, file] of screens) {
    await page.goto(url);
    await shot(page, file);
  }
});

test('capture Builder 2.0 iteration 2: sections, multi-select, history, components, Russian', async ({ page }) => {
  await signUp(page, { workspace: 'Northwind Studio' });
  const { siteId } = await createSite(page, 'Northwind');
  const site = `/sites/${siteId}`;
  await page.goto(`${site}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();

  // Section library in the palette, then a pricing section in the brand tone on the page.
  await page.getByRole('radio', { name: 'Brand colour' }).click();
  await shot(page, join('builder', 'builder-sections-palette-1440.png'));
  await page.getByRole('button', { name: 'Pricing · three plans' }).click();
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.getByRole('button', { name: 'Testimonials · grid' }).click();
  await page.getByText('Simple, transparent pricing').scrollIntoViewIfNeeded();
  await shot(page, join('builder', 'builder-sections-inserted-1440.png'));

  // Multi-select two blocks inside the pricing section: the multi toolbar.
  await page.getByRole('button', { name: /^layers$/i }).click();
  const pricing = page.locator('[role="tree"] > [role="treeitem"][aria-label="Pricing"]');
  const rows = pricing.locator(':scope > [role="treeitem"] > [data-layer-id]');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Control'] });
  await shot(page, join('builder', 'builder-multiselect-1440.png'));
  await page.keyboard.press('Control+g');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await shot(page, join('builder', 'builder-history-1440.png'));

  // Style panel: theme chips in the site's own colours.
  await page.locator('[data-block-type="heading"]').first().click();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByRole('group', { name: 'Theme colours' }).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
  await shot(page, join('builder', 'builder-style-theme-chips-1440.png'));

  // A header becomes a global component with a page-level override.
  await page.getByRole('button', { name: 'Blocks', exact: true }).click();
  await page.getByRole('button', { name: 'Header · navigation' }).click();
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await page.getByRole('button', { name: 'Make a component' }).click();
  await page.getByLabel('Component name').fill('Site header');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Instance of “Site header”')).toBeVisible();
  await page.getByLabel(/Heading · Text/).first().fill('Northwind');
  await shot(page, join('builder', 'builder-component-instance-1440.png'));
  await page.keyboard.press('Control+s');
  await page.getByRole('link', { name: 'Edit component' }).click();
  await expect(page.getByLabel('Component name')).toHaveValue('Site header');
  await shot(page, join('builder', 'builder-component-editor-1440.png'));
  await page.goto(`${site}/components`);
  await expect(page.getByText('Site header')).toBeVisible();
  await shot(page, join('cms', 'components-list-1440.png'));

  // The builder in Russian.
  await page.evaluate(() => window.localStorage.setItem('canon.locale', 'ru'));
  await page.goto(`${site}/pages`);
  await page.getByRole('link', { name: /Home|Главная/ }).first().click();
  await expect(page.getByRole('application', { name: 'Холст страницы' })).toBeVisible();
  await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: 'Стиль', exact: true }).click();
  await shot(page, join('builder', 'builder-ru-1440.png'));
});

test('capture the Canon AI plan panel (recorded model reply)', async ({ page }) => {
  await signUp(page, { workspace: 'Northwind Studio' });
  const { siteId } = await createSite(page, 'Northwind');
  await page.route('**/v1/sites/*/ai/plan', async (route) => {
    const body = route.request().postDataJSON() as { content: { root: { children: { id: string; type: string; children: { id: string; type: string }[] }[] } } };
    const hero = body.content.root.children.find((c) => c.type === 'hero')!;
    const band = body.content.root.children.find((c) => c.type === 'section')!;
    await route.fulfill({
      json: {
        summary: 'A benefit-led hero, more air on desktop, and an FAQ that answers the pricing question before visitors ask.',
        repaired: false,
        ai: { model: 'anthropic/claude-sonnet-5-5', costUsd: 0.0184 },
        operations: [
          { operation: { op: 'PROPS_UPDATE', id: hero.id, patch: { title: 'Launch in days, not months', subtitle: 'Northwind gives your team one place to build, publish and grow.' } }, label: 'Edit Hero', status: 'ok' },
          { operation: { op: 'STYLE_SET', id: hero.id, breakpoint: 'base', property: 'paddingTop', value: '120px' }, label: 'Hero padding', status: 'ok' },
          { operation: { op: 'NODE_INSERT', parentId: band.id, index: 3, nodes: [{ id: 'faqnew0001', type: 'faq', props: { title: 'Pricing questions', items: [{ q: 'Is there a free plan?', a: 'Yes, forever.' }] }, children: [] }] }, label: 'Insert FAQ', status: 'ok' },
          { operation: { op: 'STYLE_SET', id: hero.id, breakpoint: 'base', property: 'color', value: 'red;background:url(javascript:alert(1))' }, label: 'Hero colour', status: 'rejected', reason: 'Invalid value for color' },
        ],
      },
    });
  });
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: 'Canon AI', exact: true }).click();
  await page.getByLabel('What should change?').fill('Make the hero benefit-led and add an FAQ about pricing');
  await page.getByRole('button', { name: 'Propose changes' }).click();
  await expect(page.getByRole('region', { name: 'Proposed changes' })).toBeVisible();
  await shot(page, join('ai', 'canon-ai-plan-1440.png'));
  await page.getByRole('button', { name: /^Apply 3 change/ }).click();
  await shot(page, join('ai', 'canon-ai-plan-applied-1440.png'));
});
