import { describe, expect, it } from 'vitest';
import { fitWidthView, breakpointForWidth, defaultDevices, distances, fitView, marqueeSelect, nextDevicePosition, revealView, sanitizeDevices, toScreen, toWorld, widthForBreakpoint, zoomAt, MAX_ZOOM } from '../src/components/builder/board/geometry';

describe('infinite canvas geometry', () => {
  it('zooms around the cursor: the world point under it stays put', () => {
    const v = { x: 100, y: 50, zoom: 1 };
    const before = toWorld(v, 400, 300);
    const z = zoomAt(v, 2, 400, 300);
    expect(z.zoom).toBe(2);
    const after = toScreen(z, before.x, before.y);
    expect(after.x).toBeCloseTo(400);
    expect(after.y).toBeCloseTo(300);
    expect(zoomAt(v, 1000, 0, 0).zoom).toBe(MAX_ZOOM);
  });

  it('fits a box into the viewport and reveals off-screen boxes with a minimal pan', () => {
    const f = fitView({ x: 0, y: 0, w: 2000, h: 1000 }, 1000, 800, 50);
    expect(f.zoom).toBeCloseTo(0.45);
    expect(toScreen(f, 1000, 0).x).toBeCloseTo(500); // centred horizontally
    const v = { x: 0, y: 0, zoom: 1 };
    expect(revealView(v, { x: 100, y: 100, w: 50, h: 50 }, 800, 600)).toBeNull();
    const r = revealView(v, { x: 1200, y: 100, w: 100, h: 50 }, 800, 600, 40)!;
    expect(r.x).toBe(800 - 40 - 1300);
    expect(r.y).toBe(0);
    const fw = fitWidthView({ x: 0, y: -30, w: 2000, h: 9000 }, 1000, 50);
    expect(fw.zoom).toBeCloseTo(0.45);
    expect(toScreen(fw, 0, -30).y).toBeCloseTo(50);
  });

  it('maps viewport widths to the breakpoint whose styles a visitor sees', () => {
    expect(breakpointForWidth(1440)).toBe('base');
    expect(breakpointForWidth(1280)).toBe('base');
    expect(breakpointForWidth(1200)).toBe('laptop');
    expect(breakpointForWidth(768)).toBe('tablet');
    expect(breakpointForWidth(600)).toBe('mobileL');
    expect(breakpointForWidth(390)).toBe('mobileS');
    expect(breakpointForWidth(widthForBreakpoint('tablet'))).toBe('tablet');
    expect(breakpointForWidth(widthForBreakpoint('laptop'))).toBe('laptop');
  });

  it('lays artboards out side by side and rejects corrupt stored layouts', () => {
    const d = defaultDevices();
    expect(d.map((x) => x.id)).toEqual(['desktop', 'mobile']);
    expect(d[1]!.x).toBe(1440 + 160);
    expect(nextDevicePosition(d)).toEqual({ x: 1440 + 160 + 390 + 160, y: 0 });
    expect(sanitizeDevices([{ id: 'desktop', width: 1440, x: 0, y: 0 }, { id: 'desktop', width: 390, x: 1, y: 1 }, { id: 'x', width: 10, x: 0, y: 0 }, { id: '<b>', width: 500, x: 0, y: 0 }, 'nope'])).toEqual([{ id: 'desktop', width: 1440, x: 0, y: 0 }]);
    expect(sanitizeDevices('[]')).toBeNull();
    expect(sanitizeDevices([])).toBeNull();
  });

  it('marquee selects enclosed blocks without their descendants', () => {
    const hits = [
      { id: 'hero', ancestors: [], box: { x: 0, y: 0, w: 1000, h: 400 } },
      { id: 'title', ancestors: ['hero'], box: { x: 100, y: 100, w: 300, h: 60 } },
      { id: 'cta', ancestors: ['hero'], box: { x: 100, y: 200, w: 120, h: 40 } },
      { id: 'img', ancestors: ['hero'], box: { x: 600, y: 50, w: 300, h: 300 } },
    ];
    expect(marqueeSelect(hits, { x: 50, y: 50, w: 400, h: 220 })).toEqual(['title', 'cta']);
    expect(marqueeSelect(hits, { x: -10, y: -10, w: 2000, h: 1000 })).toEqual(['hero']);
    expect(marqueeSelect(hits, { x: 150, y: 110, w: 10, h: 10 })).toEqual([]);
  });

  it('measures the gaps between two boxes and the insets inside a parent', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 140, y: 10, w: 60, h: 30 };
    expect(distances(a, b)).toEqual([{ axis: 'x', x1: 100, y1: 25, x2: 140, y2: 25, value: 40 }]);
    const parent = { x: 0, y: 0, w: 400, h: 200 };
    const inset = distances({ x: 20, y: 30, w: 100, h: 40 }, parent).map((g) => g.value);
    expect(inset).toEqual([20, 280, 30, 130]);
  });
});
