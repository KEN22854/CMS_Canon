import { expect, test } from '@playwright/test';
import { createSite, signUp } from './helpers';

/**
 * The Canon AI panel end to end in the browser. The model call itself is replaced by a recorded
 * plan (the E2E stack has no model provider); the planner's server side — parsing, checking and
 * rejecting operations — is covered by apps/api/test/integration/builder-ai.test.ts. Here we check
 * what the person sees: the request carries the draft and selection, the diff, unchecking an
 * operation, rejected ones with their reason, one undo step for the whole plan.
 */
test('ask Canon AI for edits, review the diff, apply some, undo them together', async ({ page }) => {
  await signUp(page);
  const { siteId } = await createSite(page, `E2E AI plan ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();

  let request: { instruction: string; selectedIds: string[]; content: { root: { children: { id: string; type: string }[] } } } | null = null;
  await page.route('**/v1/sites/*/ai/plan', async (route) => {
    request = route.request().postDataJSON();
    const hero = request!.content.root.children.find((c) => c.type === 'hero')!;
    await route.fulfill({
      json: {
        summary: 'A sharper hero and a bigger title on desktop.',
        repaired: false,
        ai: { model: 'recorded', costUsd: 0.0012 },
        operations: [
          { operation: { op: 'PROPS_UPDATE', id: hero.id, patch: { title: 'Ship faster with Northwind' } }, label: 'Edit Hero: title', status: 'ok' },
          { operation: { op: 'STYLE_SET', id: hero.id, breakpoint: 'base', property: 'paddingTop', value: '120px' }, label: 'Hero: paddingTop 120px (base)', status: 'ok' },
          { operation: { op: 'PROPS_UPDATE', id: hero.id, patch: { subtitle: 'Not wanted' } }, label: 'Edit Hero: subtitle', status: 'ok' },
          { operation: { op: 'STYLE_SET', id: hero.id, breakpoint: 'base', property: 'color', value: 'red;x' }, label: 'Hero: color', status: 'rejected', reason: 'Invalid value for color' },
        ],
      },
    });
  });

  await page.locator('[data-block-type="hero"]').first().click({ position: { x: 10, y: 10 } });
  const title = (await page.locator('[data-block-type="hero"] h1').first().textContent())!;
  await page.getByRole('button', { name: 'Canon AI', exact: true }).click();
  await expect(page.getByText('Focuses on 1 selected block(s)')).toBeVisible();
  await page.getByLabel('What should change?').fill('Make the hero punchier');
  await page.getByRole('button', { name: 'Propose changes' }).click();

  const result = page.getByRole('region', { name: 'Proposed changes' });
  await expect(result.getByText('A sharper hero and a bigger title on desktop.')).toBeVisible();
  expect(request!.instruction).toBe('Make the hero punchier');
  expect(request!.selectedIds).toHaveLength(1);
  // The diff shows before → after; the rejected one is visible with its reason and can't be chosen.
  await expect(result.getByText(title, { exact: true })).toBeVisible();
  await expect(result.getByText('Ship faster with Northwind')).toBeVisible();
  await expect(result.getByText('120px')).toBeVisible();
  await expect(result.getByText(/Not possible: Invalid value for color/)).toBeVisible();
  await expect(result.getByRole('checkbox').nth(3)).toBeDisabled();

  // Drop the subtitle change, apply the rest.
  await result.getByRole('checkbox').nth(2).uncheck();
  await result.getByRole('button', { name: 'Apply 2 change(s)' }).click();
  await expect(page.getByText(/Applied 2 change\(s\)/)).toBeVisible();
  const hero = page.locator('[data-block-type="hero"]').first();
  await expect(hero.locator('h1')).toHaveText('Ship faster with Northwind');
  await expect.poll(() => hero.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('120px');
  await expect(hero.getByText('Not wanted')).toHaveCount(0);

  // Both changes are in History and one undo reverts both.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('list', { name: 'History' }).getByText('STYLE_SET', { exact: true })).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 890 } });
  await page.keyboard.press('Control+z');
  await expect(hero.locator('h1')).toHaveText(title);
  await expect.poll(() => hero.evaluate((el) => getComputedStyle(el).paddingTop)).not.toBe('120px');
});
