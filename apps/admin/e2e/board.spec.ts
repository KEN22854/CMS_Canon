import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';
const SHOTS = process.env.SCREENSHOTS_DIR ? `${process.env.SCREENSHOTS_DIR}/../board` : '../../docs/CANON_2/screenshots/board';

const artboard = (page: Page, id: string) => page.locator(`[data-artboard="${id}"]`);
const zoomLabel = (page: Page) => page.locator('[data-zoom-level]');

/** dnd-kit needs a real pointer gesture: press, move in steps past the activation distance, release. */
async function dragTo(page: Page, from: Locator, to: { x: number; y: number }) {
  const b = (await from.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test('infinite canvas: build on device artboards, responsive styles, save, reload and publish', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 960 });
  await signUp(page, { editor: 'board' });
  const { siteId, host } = await createSite(page, `E2E Board ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  // New editors land on the board: Desktop and Mobile artboards of the same page, side by side.
  await expect(page.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
  await expect(artboard(page, 'desktop')).toBeVisible();
  await expect(artboard(page, 'mobile')).toBeVisible();
  await expect(artboard(page, 'desktop').getByRole('application', { name: 'Page canvas' })).toBeVisible();
  await expect(artboard(page, 'mobile').getByText(/Welcome to/)).toBeVisible();
  // Opening a page is not an edit (the collaboration room's copy is the same page).
  await expect(page.getByText('Saved · v1')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/01-board.png` });

  // Zoom: Ctrl+wheel around the pointer, then the zoom-to-fit button.
  const fitZoom = await zoomLabel(page).textContent();
  await page.mouse.move(800, 500);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect(zoomLabel(page)).not.toHaveText(fitZoom!);
  await page.getByRole('button', { name: 'Zoom to fit' }).click();
  await expect(zoomLabel(page)).toHaveText(fitZoom!);

  // Drag a Heading from the library into the second section of the Desktop artboard.
  const desktop = artboard(page, 'desktop');
  const headingsBefore = await desktop.locator('[data-block-type="heading"]').count();
  const second = desktop.locator('[data-block-type="section"]').nth(1);
  await second.scrollIntoViewIfNeeded();
  const sb = (await second.boundingBox())!;
  await dragTo(page, page.locator('[data-library-item="heading"]'), { x: sb.x + sb.width / 2, y: sb.y + sb.height - 12 });
  await expect(desktop.locator('[data-block-type="heading"]')).toHaveCount(headingsBefore + 1);
  // …and it is on the Mobile artboard too: one page, many widths.
  await expect(artboard(page, 'mobile').locator('[data-block-type="heading"]')).toHaveCount(headingsBefore + 1);

  // Edit its text in place (double-click on the board).
  const added = desktop.locator('[data-block-type="heading"]').nth(headingsBefore);
  await added.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Built on the board');
  await page.keyboard.press('Enter');
  await expect(desktop.getByText('Built on the board')).toBeVisible();

  // Click-add from the library lands next to the selection: a badge and an icon.
  await page.locator('[data-library-item="badge"]').click();
  await page.locator('[data-library-item="icon"]').click();
  await expect(desktop.locator('[data-block-type="badge"]')).toHaveCount(1);
  await expect(desktop.locator('[data-block-type="icon"] svg')).toHaveCount(1);

  // Rectangle selection from the empty board selects the enclosed sections.
  const db = (await desktop.boundingBox())!;
  const hero = desktop.locator('[data-block-type="hero"]');
  const hb = (await hero.boundingBox())!;
  await page.mouse.move(db.x - 30, hb.y - 20);
  await page.mouse.down();
  await page.mouse.move(db.x + db.width / 2, hb.y + hb.height / 2, { steps: 5 });
  await page.mouse.move(db.x + db.width + 20, hb.y + hb.height + 6, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByText('Hero').last()).toBeVisible();
  await expect(page.locator('[data-block-type="hero"]').first()).toBeVisible();

  // Right-click a block: the context menu duplicates it (one undo step), Ctrl+Z takes it back.
  const heroes = await desktop.locator('[data-block-type="hero"]').count();
  await hero.click({ button: 'right', position: { x: 40, y: 40 } });
  const menu = page.getByRole('menu', { name: 'Block actions' });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-context-menu.png` });
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(desktop.locator('[data-block-type="hero"]')).toHaveCount(heroes + 1);
  await page.keyboard.press('Control+z');
  await expect(desktop.locator('[data-block-type="hero"]')).toHaveCount(heroes);

  // Add a Tablet artboard: it becomes the one being edited (tablet breakpoint).
  await page.getByRole('button', { name: 'Device', exact: true }).click();
  await page.getByRole('menuitem', { name: /Tablet/ }).click();
  await expect(artboard(page, 'tablet')).toBeVisible();
  await expect(page.locator('[data-artboard="tablet"] [data-frame-active]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Zoom to fit' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/03-three-devices.png` });

  // Responsive: on the Mobile artboard, make the new heading smaller — Desktop keeps its size.
  const mobile = artboard(page, 'mobile');
  await mobile.getByText('Built on the board').click();
  await expect(page.locator('[data-artboard="mobile"] [data-frame-active]')).toHaveCount(1);
  await mobile.getByText('Built on the board').click();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await expect(page.getByText(/Editing Mobile S/)).toBeVisible();
  await page.getByLabel('Size', { exact: true }).fill('20px');
  await page.getByLabel('Size', { exact: true }).press('Tab');
  const size = (board: string) => page.locator(`[data-artboard="${board}"] h2:has-text("Built on the board")`).evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(() => size('mobile')).toBe('20px');
  expect(await size('desktop')).not.toBe('20px');
  await page.screenshot({ path: `${SHOTS}/04-responsive.png` });

  // Layers and the board stay in sync: picking a layer selects that block on the artboards.
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.locator('[role="treeitem"][aria-label="Hero"] > [data-layer-id]').first().click();
  await expect(page.locator('[data-artboard="mobile"] [data-frame-active]')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/05-layers.png` });

  // Save, reload: the page and the board layout (three artboards) come back.
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(artboard(page, 'tablet')).toBeVisible();
  await expect(artboard(page, 'desktop').getByText('Built on the board')).toBeVisible();
  await expect.poll(() => size('mobile')).toBe('20px');

  // Publish with the existing pipeline: the live site has the blocks, responsive CSS included.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText(/^Published —/)).toBeVisible();
  await expect
    .poll(async () => {
      const res = await request.get(`http://localhost:${WEB_PORT}/`, { headers: { 'x-forwarded-host': host } });
      return res.ok() ? res.text() : '';
    })
    .toContain('Built on the board');
  const html = await (await request.get(`http://localhost:${WEB_PORT}/`, { headers: { 'x-forwarded-host': host } })).text();
  expect(html).toContain('font-size:20px');
  expect(html).toMatch(/<svg[^>]*lucide/);
  expect(html).toContain('>New<');
  // The board is editor-only: none of its chrome reaches the site.
  expect(html).not.toContain('data-artboard');
  expect(html).not.toContain('data-block-id');
});

test('infinite canvas: hand tool and Space pan the board, context menu on the empty board', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, { editor: 'board' });
  const { siteId } = await createSite(page, `E2E Pan ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const desktop = artboard(page, 'desktop');
  await expect(desktop).toBeVisible();
  await page.waitForTimeout(500);
  const before = (await desktop.boundingBox())!;

  // Right-click on the empty board (left of the artboard): board commands.
  await page.mouse.click(before.x - 24, before.y + 120, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Block actions' });
  await expect(menu.getByRole('menuitem', { name: 'Zoom to fit' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Select all' }).click();
  await expect(page.getByText(/\d+ selected/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Hand tool: dragging anywhere (even over the page) moves the board and selects nothing.
  await page.getByRole('button', { name: /Hand/ }).click();
  await page.mouse.move(before.x + 100, before.y + 100);
  await page.mouse.down();
  await page.mouse.move(before.x + 40, before.y + 20, { steps: 6 });
  await page.mouse.up();
  const afterHand = (await desktop.boundingBox())!;
  expect(Math.round(afterHand.x - before.x)).toBe(-60);
  expect(Math.round(afterHand.y - before.y)).toBe(-80);

  // Back to Select (V); hold Space to pan temporarily.
  await page.keyboard.press('v');
  await page.keyboard.down('Space');
  await page.mouse.move(afterHand.x + 10, afterHand.y + 10);
  await page.mouse.down();
  await page.mouse.move(afterHand.x + 60, afterHand.y + 10, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(Math.round((await desktop.boundingBox())!.x - afterHand.x)).toBe(50);

  // Plain wheel pans; the minimap shows where you are.
  await page.mouse.move(700, 450);
  const y0 = (await desktop.boundingBox())!.y;
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => Math.round((await desktop.boundingBox())!.y - y0)).toBe(-200);
  await expect(page.locator('[data-minimap]')).toBeVisible();
});
