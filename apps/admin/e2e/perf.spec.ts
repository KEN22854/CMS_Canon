import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createSite, signUp } from './helpers';

/**
 * Editor and live-page timings in a real browser (opt-in: PERF_REPORT=path/to/report.json).
 * Pages of 1 000 and 3 000 blocks are built through the builder's own paste path, then we time
 * inserting them, selecting a block, a style edit reaching the canvas, saving, and the published
 * page's paint metrics. Numbers are from this machine and Chromium; they compare runs, not devices.
 */
const REPORT = process.env.PERF_REPORT;
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3001';
test.skip(!REPORT, 'set PERF_REPORT to run the performance measurements');
test.setTimeout(240_000);

/** Sections of one heading + eight text blocks each, styled at two breakpoints (like real pages). */
function blocks(total: number) {
  const out: unknown[] = [];
  let made = 0;
  for (let s = 0; made < total; s++) {
    const kids = Array.from({ length: Math.min(9, total - made - 1) }, (_, i) => ({
      id: `p${s}x${i}`,
      type: i === 0 ? 'heading' : 'text',
      props: i === 0 ? { text: `Section ${s}`, level: 2, align: 'left' } : { doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${s}.${i} with some body copy to lay out.` }] }] }, align: 'left' },
      children: [],
      styles: { base: { marginTop: '8px', fontSize: `${16 + (i % 4)}px` }, tablet: { fontSize: '15px' } },
    }));
    out.push({ id: `p${s}`, type: 'section', props: { background: 'default', paddingY: 'md', width: 'default', anchor: '' }, children: kids, styles: { base: { paddingTop: '48px' }, mobileL: { paddingTop: '24px' } } });
    made += 1 + kids.length;
  }
  return out;
}

async function openHome(page: Page, siteId: string) {
  await page.goto(`/sites/${siteId}/pages`);
  await page.getByRole('link', { name: 'Home' }).first().click();
  await expect(page.getByRole('application', { name: 'Page canvas' })).toBeVisible();
}

/** Time from a trigger to `ready()` turning true, sampled every animation frame (≈ paint). */
async function timeInPage(page: Page, ready: string, trigger: () => Promise<void>): Promise<number> {
  await page.evaluate((src) => {
    const w = window as unknown as { __perf: { t0: number; t1: number | null } };
    w.__perf = { t0: 0, t1: null };
    const check = new Function(`return (${src})`) as () => boolean;
    const tick = () => {
      if (w.__perf.t0 && check()) w.__perf.t1 = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ready);
  await page.evaluate(() => ((window as unknown as { __perf: { t0: number } }).__perf.t0 = performance.now()));
  await trigger();
  await page.waitForFunction(() => (window as unknown as { __perf: { t1: number | null } }).__perf.t1 !== null, null, { timeout: 120_000 });
  return page.evaluate(() => {
    const p = (window as unknown as { __perf: { t0: number; t1: number } }).__perf;
    return Math.round(p.t1 - p.t0);
  });
}

async function longTasks(page: Page, run: () => Promise<void>): Promise<{ count: number; totalMs: number; maxMs: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __lt: number[] };
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({ type: 'longtask', buffered: false });
  });
  await run();
  return page.evaluate(() => {
    const lt = (window as unknown as { __lt: number[] }).__lt;
    return { count: lt.length, totalMs: Math.round(lt.reduce((a, b) => a + b, 0)), maxMs: Math.round(Math.max(0, ...lt)) };
  });
}

const results: Record<string, unknown> = {};

for (const size of [1000, 3000]) {
  test(`editor with ${size} blocks`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signUp(page);
    const { siteId, host } = await createSite(page, `Perf ${size} ${Date.now() % 100000}`);
    await openHome(page, siteId);
    // The default page's own blocks stay; generated ones fill the page up to exactly `size` blocks (the cap is 3 000).
    const existing = await page.locator('[data-block-id]').count();
    const nodes = blocks(size - existing);
    await page.evaluate((n) => window.localStorage.setItem('canon.builder.clipboard', JSON.stringify({ v: 1, nodes: n })), nodes);
    await page.locator('[role="application"]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');

    let insertMs = 0;
    const insertLong = await longTasks(page, async () => {
      insertMs = await timeInPage(page, `document.querySelectorAll('[data-block-id]').length >= ${size}`, () => page.keyboard.press('Control+v'));
    });

    // Select a block deep in the page.
    const deep = page.locator('[data-block-type="heading"]').nth(Math.floor(size / 20));
    await deep.scrollIntoViewIfNeeded();
    const selectMs = await timeInPage(page, `!!document.querySelector('[role="application"] .border-2.border-primary')`, () => deep.click());

    // A style edit: keystroke → compiled CSS on the canvas.
    await page.getByRole('button', { name: 'Style', exact: true }).click();
    const field = page.getByLabel('Padding top', { exact: true });
    await field.click();
    const styleMs = await timeInPage(page, `[...document.querySelectorAll('style[data-canon-styles]')].some((el) => el.textContent?.includes('padding-top:77px'))`, () => page.keyboard.type('77'));

    // Typing into a prop (inspector → canvas text).
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    const text = page.getByLabel('Text', { exact: true }).first();
    await text.click();
    await page.keyboard.press('End');
    const typeMs = await timeInPage(page, `[...document.querySelectorAll('[data-block-type="heading"]')].some((h) => h.textContent?.endsWith('Q'))`, () => page.keyboard.type('Q'));

    const t0 = Date.now();
    await page.keyboard.press('Control+s');
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 60_000 });
    const saveMs = Date.now() - t0;

    const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

    // Publish and measure the live page in a fresh tab.
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published — the site updates within seconds')).toBeVisible({ timeout: 60_000 });
    const url = `http://${host}:${WEB_PORT}/`;
    await expect.poll(async () => ((await request.get(url).catch(() => null))?.status() ?? 0), { timeout: 30_000 }).toBe(200);
    const live = await page.context().newPage();
    await live.setViewportSize({ width: 1280, height: 800 });
    await live.addInitScript(() => {
      const w = window as unknown as { __v: { lcp: number; cls: number; lt: number[] } };
      w.__v = { lcp: 0, cls: 0, lt: [] };
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__v.lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => !(e as unknown as { hadRecentInput: boolean }).hadRecentInput && (w.__v.cls += (e as unknown as { value: number }).value))).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__v.lt.push(e.duration))).observe({ type: 'longtask', buffered: true });
    });
    await live.goto(url, { waitUntil: 'load' });
    await live.waitForTimeout(1500);
    const vitals = await live.evaluate(() => {
      const w = window as unknown as { __v: { lcp: number; cls: number; lt: number[] } };
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const js = res.filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js'));
      // Total blocking time: the part of each long task over 50 ms.
      const tbt = w.__v.lt.reduce((a, d) => a + Math.max(0, d - 50), 0);
      return {
        ttfbMs: Math.round(nav.responseStart - nav.requestStart),
        fcpMs: Math.round(fcp),
        lcpMs: Math.round(w.__v.lcp),
        cls: Number(w.__v.cls.toFixed(3)),
        tbtMs: Math.round(tbt),
        htmlKB: Math.round(nav.transferSize / 1024),
        htmlDecodedKB: Math.round(nav.decodedBodySize / 1024),
        requests: res.length + 1,
        jsKB: Math.round(js.reduce((a, r) => a + r.transferSize, 0) / 1024),
        domNodes: document.getElementsByTagName('*').length,
      };
    });
    await live.close();

    results[String(size)] = { blocks: size, insertMs, insertLongTasks: insertLong, selectMs, styleEditMs: styleMs, typeMs, saveMs, heapMB: Math.round(heap / 1048576), live: vitals };
    writeFileSync(REPORT!, JSON.stringify(results, null, 2));
  });
}
