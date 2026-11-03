import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';

async function openHome(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
}

test('insert a ready-made section, multi-select, group, copy and paste, see the operation log', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E Sections ${Date.now() % 100000}`);
  await openHome(page, siteId);

  // A three-plan pricing section in the dark tone: regular blocks, valid on save.
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('button', { name: 'Pricing · three plans' }).click();
  await expect(page.getByText('Simple, transparent pricing')).toBeVisible();
  await expect(page.locator('[data-block-type="group"]')).not.toHaveCount(0);

  // Two sections can't share a group: the builder says why instead of doing nothing.
  await page.getByRole('button', { name: /^layers$/i }).click();
  const top = page.locator('[role="tree"] > [role="treeitem"] > [data-layer-id]');
  await top.nth(1).click();
  await top.nth(2).click({ modifiers: ['Control'] });
  await expect(page.getByText('2 selected').first()).toBeVisible();
  await page.keyboard.press('Control+g');
  await expect(page.getByText(/can’t be grouped/)).toBeVisible();

  // Inside the pricing section: Ctrl+click its title and subtitle, group them (Ctrl+G).
  const pricing = page.locator('[role="tree"] > [role="treeitem"][aria-label="Pricing"]');
  const kids = () => pricing.locator(':scope > [role="treeitem"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const before = await kids();
  const rows = pricing.locator(':scope > [role="treeitem"] > [data-layer-id]');
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['Control'] });
  await page.keyboard.press('Control+g');
  await expect.poll(kids).toHaveLength(before.length - 1);
  expect((await kids())[0]).toBe('Group');

  // Copy and paste the selected group: it lands right after it, with new ids.
  await page.keyboard.press('Control+c');
  await expect(page.getByText(/Copied 1 block/)).toBeVisible();
  await page.keyboard.press('Control+v');
  await expect(page.getByText(/Pasted 1 block/)).toBeVisible();
  await expect.poll(kids).toHaveLength(before.length);

  // Ungroup the copy: its two blocks come back as siblings.
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(kids).toHaveLength(before.length + 1);

  // Every edit is a typed operation in the History tab.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const log = page.getByRole('list', { name: 'History' });
  for (const op of ['NODE_INSERT', 'NODE_GROUP', 'NODE_UNGROUP']) await expect(log.getByText(op, { exact: true }).first()).toBeVisible();

  // Undo goes back step by step.
  await page.keyboard.press('Control+z');
  await page.getByRole('button', { name: /^layers$/i }).click();
  await expect.poll(kids).toHaveLength(before.length);

  // Typing a number digit by digit means pixels and is not mangled while typing.
  await page.locator('[data-block-type="group"]').first().click({ position: { x: 4, y: 4 } });
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByLabel('Padding top', { exact: true }).click();
  await page.keyboard.type('48');
  await expect.poll(() => page.locator('style[data-canon-styles]').allTextContents().then((t) => t.join('\n'))).toContain('padding-top:48px');
  await page.getByLabel('Padding bottom', { exact: true }).click();
  await expect(page.getByLabel('Padding top', { exact: true })).toHaveValue('48px');

  // The whole page still validates on the server.
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

test('make a component, override its text on a page, and publish it to the live site', async ({ page, request }) => {
  await signUp(page);
  const { siteId, host } = await createSite(page, `E2E Components ${Date.now() % 100000}`);
  await openHome(page, siteId);

  await page.getByRole('button', { name: 'Header · navigation' }).click();
  await expect(page.locator('[data-block-type="section"]').first()).toBeVisible();
  // The inserted header section is selected: make it a component.
  await page.getByRole('button', { name: 'Make a component' }).click();
  await page.getByLabel('Component name').fill('Site header');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Component “Site header” created. This block is now an instance of it.')).toBeVisible();
  await expect(page.getByText('Instance of “Site header”')).toBeVisible();
  await expect(page.locator('[data-component-instance]')).toHaveCount(1);

  // Override the brand text on this page only.
  await page.getByLabel(/Heading · Text/).first().fill('Acme');
  await expect(page.locator('[data-component-instance]').getByText('Acme', { exact: true })).toBeVisible();

  // The palette now offers the component; a second instance shows the original text.
  await page.getByRole('button', { name: 'Site header', exact: true }).click();
  await expect(page.locator('[data-component-instance]')).toHaveCount(2);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  await expect
    .poll(async () => {
      const res = await request.get(`http://${host}:${WEB_PORT}/`).catch(() => null);
      return res ? await res.text() : '';
    }, { timeout: 30_000 })
    .toContain('>Acme<');
  const html = await (await request.get(`http://${host}:${WEB_PORT}/`)).text();
  expect(html).toContain('Your brand');

  // The component has its own builder and list.
  await page.getByRole('link', { name: 'Edit component' }).click();
  await expect(page.getByLabel('Component name')).toHaveValue('Site header');
  await expect(page.getByText(/^Live v1$/)).toBeVisible();
  await page.goto(`/sites/${siteId}/components`);
  await expect(page.getByText('Site header')).toBeVisible();
});

test('the builder speaks Russian', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E RU ${Date.now() % 100000}`);
  await page.evaluate(() => window.localStorage.setItem('canon.locale', 'ru'));
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: /Home|Главная/ }).first().click();
  await expect(page.getByRole('application', { name: 'Холст страницы' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Стиль', exact: true })).toBeVisible();
  await expect(page.getByText('Готовые секции')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Тарифы · 3 плана', exact: true })).toBeVisible();
  await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
  await page.getByRole('button', { name: 'Стиль', exact: true }).click();
  await expect(page.getByText('Редактируется: Десктоп')).toBeVisible();
  await expect(page.getByLabel('Внутренний сверху', { exact: true })).toBeVisible();
});
