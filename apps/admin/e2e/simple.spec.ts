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

async function openHome(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
}

const topTypes = (page: Page) => page.locator('[role="application"] [data-block-id]').evaluateAll((els) => els.filter((e) => e.parentElement?.closest('[data-block-id]')?.parentElement?.closest('[data-block-id]') === null).map((e) => e.getAttribute('data-block-type')));

test.setTimeout(120_000);

test('simple editor: library, block bar, in-place text, free-form drag and resize, page templates', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'simple' });
  const { siteId, host } = await createSite(page, `E2E Simple ${Date.now() % 100000}`);
  await openHome(page, siteId);
  const canvas = page.getByRole('application', { name: 'Page canvas' });

  // Clean page: no palette or inspector until asked for.
  await expect(page.getByRole('complementary', { name: 'Blocks and layers' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await shot(page, 'builder/simple-page-1440.png');

  // In-place text: double-click the hero title, type, Enter.
  const h1 = canvas.locator('[data-block-type="hero"] h1').first();
  await h1.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Bake bread at home');
  await page.keyboard.press('Enter');
  await expect(h1).toHaveText('Bake bread at home');

  // The block bar: Content opens the inspector drawer with the same text.
  await h1.hover();
  await page.getByRole('button', { name: 'Content' }).first().click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Bake bread at home');
  await shot(page, 'builder/simple-block-bar-1440.png');
  await page.getByRole('button', { name: 'Close panel' }).click();

  // "Add block" opens the library; insert a pricing section at the end.
  await page.getByRole('button', { name: 'Add block' }).click();
  const library = page.getByRole('dialog', { name: 'Block library' });
  await expect(library).toBeVisible();
  await library.getByRole('button', { name: /^Pricing/ }).first().click();
  await shot(page, 'builder/simple-library-1440.png');
  await library.getByRole('button', { name: 'Insert Pricing · three plans' }).click();
  await expect(library).toHaveCount(0);
  await expect(canvas.getByText('Simple, transparent pricing')).toBeVisible();

  // "+" at the top of a block inserts right there: a free-form collage above the hero.
  await h1.hover();
  await page.getByRole('button', { name: 'Add a block here' }).first().click();
  await library.getByRole('button', { name: /^Free-form/ }).first().click();
  await library.getByRole('button', { name: 'Insert Free-form · collage hero' }).click();
  await expect.poll(() => topTypes(page)).toEqual(expect.arrayContaining(['canvas']));
  expect((await topTypes(page))[0]).toBe('canvas');

  // Free-form: select the headline, drag it 96 px right and 48 px down, then resize it.
  const free = canvas.locator('[data-block-type="canvas"]').first();
  const heading = free.locator('[data-block-type="heading"]').first();
  await heading.click();
  const box = (await heading.boundingBox())!;
  const handle = page.getByLabel(/Drag to move/).first();
  await expect(handle).toBeVisible();
  const leftBefore = await heading.evaluate((el) => parseFloat(getComputedStyle(el).left));
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + 96 * 0.6, box.y + 20 + 48 * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => heading.evaluate((el) => parseFloat(getComputedStyle(el).left))).toBeGreaterThan(leftBefore + 40);
  const leftAfter = await heading.evaluate((el) => parseFloat(getComputedStyle(el).left));
  expect(Number.isInteger(leftAfter)).toBe(true); // on the grid or exactly on a guide
  await shot(page, 'builder/simple-freeform-1440.png');

  // One undo puts it back.
  await page.keyboard.press('Control+z');
  await expect.poll(() => heading.evaluate((el) => parseFloat(getComputedStyle(el).left))).toBe(leftBefore);

  // Board: Shift+click the image too, align both to the left edge of the selection; one undo puts it back.
  const image = free.locator('[data-block-type="image"]').first();
  const imageLeft = () => image.evaluate((el) => parseFloat(getComputedStyle(el).left));
  const imageBefore = await imageLeft();
  expect(imageBefore).toBeGreaterThan(leftBefore);
  await image.click({ modifiers: ['Shift'] });
  await expect(page.getByRole('button', { name: 'Distribute horizontally' })).toHaveCount(0); // needs three
  await shot(page, 'builder/simple-board-1440.png');
  await page.getByRole('button', { name: 'Align left' }).click();
  await expect.poll(imageLeft).toBe(leftBefore);
  await page.keyboard.press('Control+z');
  await expect.poll(imageLeft).toBe(imageBefore);
  expect((await topTypes(page))[0]).toBe('canvas'); // only the alignment was undone

  // Animation: the headline slides up when scrolled into view (a plain click selects it alone).
  const hb = (await heading.boundingBox())!;
  await page.mouse.click(hb.x + 20, hb.y + 15);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(''); // Shift+click selected no text
  await page.getByRole('button', { name: 'Element design and animation' }).click();
  await page.getByLabel('Entrance').selectOption('slide-up');
  await page.getByLabel('Delay, ms').fill('200');
  await page.getByRole('button', { name: 'Play the animation' }).click();
  await shot(page, 'builder/simple-animation-1440.png');
  await page.getByRole('button', { name: 'Close panel' }).click();

  // A hero with a background video, from the library.
  await page.getByRole('button', { name: 'Add block' }).click();
  await library.getByRole('button', { name: /^Hero/ }).first().click();
  await library.getByRole('button', { name: 'Insert Hero · video: city from above' }).click();
  await expect(canvas.locator('video[src*="assets.mixkit.co"]')).toHaveCount(1);
  await canvas.locator('video[src*="assets.mixkit.co"]').scrollIntoViewIfNeeded();
  await shot(page, 'builder/simple-video-hero-1440.png');

  // Mobile: "Arrange" stacks the elements for Mobile L without touching desktop.
  await page.getByRole('radio', { name: /Mobile L/ }).click();
  await free.hover();
  await page.getByRole('button', { name: /Stack the elements for Mobile L/ }).click();
  await expect(page.getByText(/Elements stacked for Mobile L/)).toBeVisible();
  await page.getByRole('radio', { name: /^Desktop/ }).click();
  await expect.poll(() => heading.evaluate((el) => parseFloat(getComputedStyle(el).left))).toBe(leftBefore);

  // Save: the page with a free-form block validates on the server.
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // Published, the free-form block renders on the live site with its positions per breakpoint.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published — the site updates within seconds')).toBeVisible();
  await expect.poll(async () => (await (await request.get(`http://${host}:${WEB_PORT}/`)).text()).includes('data-free-frame'), { timeout: 30_000 }).toBe(true);
  const html = await (await request.get(`http://${host}:${WEB_PORT}/`)).text();
  expect(html).toContain('Bake bread at home');
  expect(html).toContain('position:absolute');
  expect(html).not.toContain('data-field'); // editing attributes stay in the builder
  expect(html).toMatch(/<h1[^>]+data-anim="slide-up"/); // on the headline, not the whole block
  expect(html).toContain('--anim-delay:200ms');
  expect(html).toMatch(/<video[^>]+src="https:\/\/assets\.mixkit\.co\/videos\/41541/);
  expect(html).toContain('41541-thumb-720-0.jpg'); // the poster is the clip's own frame

  // A page template replaces the page (undoable).
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Add block' }).click();
  await library.getByRole('button', { name: /^Page templates/ }).click();
  await library.getByRole('button', { name: 'Use this page template: Product landing' }).click();
  await expect.poll(async () => (await topTypes(page)).length).toBeGreaterThanOrEqual(10);
  await shot(page, 'builder/simple-template-1440.png');

  // Pro mode brings back the palette and layers.
  await page.getByRole('radio', { name: 'Pro' }).click();
  await expect(page.getByRole('complementary', { name: 'Blocks and layers' })).toBeVisible();
});
