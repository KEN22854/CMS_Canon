import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

test('two editors on one page see each other’s edits live, and only one autosaves', async ({ browser }) => {
  const first = await browser.newContext();
  const a = await first.newPage();
  await signUp(a);
  await createSite(a, `E2E Collab ${Date.now() % 100000}`);
  await a.getByRole('link', { name: 'Home' }).first().click();
  await expect(a).toHaveURL(/\/pages\/[^/]+$/);
  const editorUrl = a.url();

  // The second tab shares the session (same person, second window), which is enough for the room.
  const second = await browser.newContext({ storageState: await first.storageState() });
  const b = await second.newPage();
  await b.goto(editorUrl);

  for (const p of [a, b]) await expect(p.getByLabel('People editing this page').locator('span').first()).toHaveAttribute('title', 'Live');

  const title = `Edited together ${Date.now()}`;
  await a.getByLabel('Page title').fill(title);
  await expect(b.getByLabel('Page title')).toHaveValue(title);

  // Both end on the same saved version: the leader saved, the follower adopted its marker.
  await expect(a.getByText(/Saved · v\d+/)).toBeVisible({ timeout: 20_000 });
  const version = (await a.getByText(/Saved · v\d+/).textContent())!.match(/v(\d+)/)![1];
  await expect(b.getByText(`Saved · v${version}`)).toBeVisible({ timeout: 20_000 });

  await first.close();
  await second.close();
});

test('board: collaborators see each other’s cursors and selections on the artboards', async ({ browser }) => {
  const first = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const a = await first.newPage();
  await signUp(a, { editor: 'board' });
  await createSite(a, `E2E Cursors ${Date.now() % 100000}`);
  await a.getByRole('link', { name: 'Home' }).first().click();
  await expect(a.locator('[data-artboard="desktop"]')).toBeVisible();
  const second = await browser.newContext({ viewport: { width: 1500, height: 900 }, storageState: await first.storageState() });
  const b = await second.newPage();
  await b.goto(a.url());
  for (const p of [a, b]) await expect(p.getByLabel('People editing this page').locator('span').first()).toHaveAttribute('title', 'Live');

  // B points at the Desktop artboard: A sees B's cursor there, at the same spot of the page.
  const box = (await b.locator('[data-artboard="desktop"] [data-frame-active]').boundingBox())!;
  await b.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 4 });
  await b.mouse.move(box.x + box.width / 2 + 20, box.y + 140, { steps: 4 });
  await expect(a.locator('[data-artboard="desktop"] [data-remote-cursor]')).toHaveCount(1);

  // B selects the hero: A sees it outlined with B's name.
  await b.locator('[data-artboard="desktop"] [data-block-type="hero"]').click({ position: { x: 30, y: 30 } });
  await expect(a.locator('[data-artboard="desktop"]').getByText('E2E Tester').first()).toBeVisible();

  // B leaves the artboard: the cursor goes away for A.
  await b.mouse.move(box.x - 40, box.y + 40);
  await expect(a.locator('[data-remote-cursor]')).toHaveCount(0);
  await first.close();
  await second.close();
});
