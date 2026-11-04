import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

/**
 * Board timings with a large page on two artboards (opt-in: PERF_REPORT=path/to/board-report.json):
 * pasting 1 500 blocks, panning (wheel), zooming (Ctrl+wheel → relayout), selecting a block and
 * zooming to it. Long tasks are counted during each gesture; numbers compare runs on one machine.
 */
const REPORT = process.env.PERF_REPORT;
test.skip(!REPORT, 'set PERF_REPORT to run the performance measurements');
test.setTimeout(240_000);

function blocks(total: number) {
  const out: unknown[] = [];
  let made = 0;
  for (let s = 0; made < total; s++) {
    const kids = Array.from({ length: Math.min(9, total - made - 1) }, (_, i) => ({
      id: `b${s}x${i}`,
      type: i === 0 ? 'heading' : 'text',
      props: i === 0 ? { text: `Section ${s}`, level: 2, align: 'left' } : { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${s}.${i} with some body copy.` }] }] }, align: 'left' },
      children: [],
      styles: { base: { marginTop: '8px' }, mobileS: { fontSize: '15px' } },
    }));
    out.push({ id: `b${s}`, type: 'section', props: { background: 'default', paddingY: 'md', width: 'default', anchor: '' }, children: kids });
    made += 1 + kids.length;
  }
  return out;
}

async function longTasks(page: Page, run: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __lt: number[] };
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({ type: 'longtask', buffered: false });
  });
  const t0 = Date.now();
  await run();
  const ms = Date.now() - t0;
  const lt = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
  return { ms, longTasks: lt.length, longestMs: Math.round(Math.max(0, ...lt)) };
}

test('board with 1 500 blocks on two artboards', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 960 });
  await signUp(page, { editor: 'board' });
  const { siteId } = await createSite(page, `Board perf ${Date.now() % 100000}`);
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  const desktop = page.locator('[data-artboard="desktop"]');
  await expect(desktop).toBeVisible();
  const existing = await desktop.locator('[data-block-id]').count();
  const size = 1500;
  await page.evaluate((n) => window.localStorage.setItem('canon.builder.clipboard', JSON.stringify({ v: 1, nodes: n })), blocks(size - existing));
  await page.keyboard.press('Escape');

  const paste = await longTasks(page, async () => {
    await page.keyboard.press('Control+v');
    await expect.poll(() => desktop.locator('[data-block-id]').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(size);
  });

  await page.mouse.move(800, 500);
  const pan = await longTasks(page, async () => {
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200);
  });

  const zoom = await longTasks(page, async () => {
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -60);
    await page.keyboard.up('Control');
    await page.waitForTimeout(600); // the zoom commits after the wheel stops
  });

  const target = desktop.locator('[data-block-type="heading"]').nth(40);
  const select = await longTasks(page, async () => {
    await target.click();
    await page.waitForTimeout(200);
  });
  const zoomToSelection = await longTasks(page, async () => {
    await page.keyboard.press('Shift+2');
    await page.waitForTimeout(400);
  });
  const layers = await longTasks(page, async () => {
    await page.getByRole('tab', { name: 'Layers' }).click();
    await expect(page.locator('[data-layer-id]').first()).toBeVisible();
  });

  const result = { blocks: size, artboards: 2, paste, pan, zoom, select, zoomToSelection, layers, heapMB: Math.round(((await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0)) / 1048576) * 10) / 10 };
  writeFileSync(REPORT!, JSON.stringify(result, null, 2));
});
