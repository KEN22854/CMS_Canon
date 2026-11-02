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
