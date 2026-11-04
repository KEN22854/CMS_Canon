import { STYLE_BREAKPOINTS, type StyleBreakpoint } from '@canon/blocks';

/**
 * Infinite-canvas maths: the viewport (pan + zoom), device artboards laid out on the board, and
 * the hit tests behind marquee selection. Pure functions, so they are unit-tested on their own.
 *
 * Coordinates: "world" is board space in CSS pixels of the page (an artboard 1440 wide is 1440
 * world px); "screen" is pixels inside the board's viewport element. screen = world × zoom + pan.
 */

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
export const ZOOM_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));

/** Zooms by `factor` keeping the screen point (px, py) over the same world point (wheel, pinch). */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(v.zoom * factor);
  const k = zoom / v.zoom;
  return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export const toWorld = (v: View, sx: number, sy: number) => ({ x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom });
export const toScreen = (v: View, wx: number, wy: number) => ({ x: wx * v.zoom + v.x, y: wy * v.zoom + v.y });

/** The view that shows `box` (world) centred in a viewport of `w × h`, with `pad` screen px around it. */
export function fitView(box: Box, w: number, h: number, pad = 48, maxZoom = 1): View {
  const zoom = clampZoom(Math.min(maxZoom, (w - pad * 2) / Math.max(1, box.w), (h - pad * 2) / Math.max(1, box.h)));
  return { zoom, x: (w - box.w * zoom) / 2 - box.x * zoom, y: Math.max(pad, (h - box.h * zoom) / 2) - box.y * zoom };
}

/** Fits the width only and starts at the top: how a long page opens (whole-height fit would make it tiny). */
export function fitWidthView(box: Box, w: number, pad = 48, maxZoom = 1): View {
  const zoom = clampZoom(Math.min(maxZoom, (w - pad * 2) / Math.max(1, box.w)));
  return { zoom, x: (w - box.w * zoom) / 2 - box.x * zoom, y: pad - box.y * zoom };
}

/** Pans as little as possible so `box` (world) is inside the viewport; null when it already is. */
export function revealView(v: View, box: Box, w: number, h: number, pad = 40): View | null {
  const s = { x: box.x * v.zoom + v.x, y: box.y * v.zoom + v.y, w: box.w * v.zoom, h: box.h * v.zoom };
  let dx = 0;
  let dy = 0;
  if (s.w + pad * 2 > w) dx = pad - s.x;
  else if (s.x < pad) dx = pad - s.x;
  else if (s.x + s.w > w - pad) dx = w - pad - (s.x + s.w);
  if (s.y < pad || s.h + pad * 2 > h) dy = pad - s.y;
  else if (s.y + s.h > h - pad) dy = h - pad - (s.y + s.h);
  return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : null;
}

export const union = (bs: Box[]): Box | null => {
  if (!bs.length) return null;
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
};

export const normalizeBox = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

export const contains = (outer: Box, inner: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ── devices & artboards ──────────────────────────────────────────────────────

export interface Device {
  id: string;
  /** Viewport width the artboard renders at (CSS px). */
  width: number;
  /** Board position of the artboard's top-left corner (world px). */
  x: number;
  y: number;
}

export const DEVICE_PRESETS = [
  { id: 'desktop', width: 1440 },
  { id: 'laptop', width: 1200 },
  { id: 'tablet', width: 768 },
  { id: 'mobile', width: 390 },
] as const;
export type DevicePreset = (typeof DEVICE_PRESETS)[number]['id'];

export const MIN_DEVICE_WIDTH = 320;
export const MAX_DEVICE_WIDTH = 2560;
export const ARTBOARD_GAP = 160;

/**
 * The style breakpoint a viewport width edits: the most specific one whose container query
 * matches that width, i.e. the styles a visitor with that screen sees on top of the larger ones.
 */
export function breakpointForWidth(width: number): StyleBreakpoint {
  let bp: StyleBreakpoint = 'base';
  for (const b of STYLE_BREAKPOINTS) if (b.max !== null && width <= b.max) bp = b.id;
  return bp;
}

/** A device for a breakpoint, at the width that breakpoint previews at (top bar buttons). */
export const widthForBreakpoint = (bp: StyleBreakpoint) => (bp === 'base' ? 1440 : STYLE_BREAKPOINTS.find((b) => b.id === bp)!.preview);

/** Places a new artboard to the right of the others, top-aligned. */
export function nextDevicePosition(devices: Device[]): { x: number; y: number } {
  if (!devices.length) return { x: 0, y: 0 };
  const right = Math.max(...devices.map((d) => d.x + d.width));
  return { x: right + ARTBOARD_GAP, y: Math.min(...devices.map((d) => d.y)) };
}

export function defaultDevices(): Device[] {
  const out: Device[] = [];
  for (const id of ['desktop', 'mobile'] as const) {
    const p = DEVICE_PRESETS.find((d) => d.id === id)!;
    out.push({ id, width: p.width, ...nextDevicePosition(out) });
  }
  return out;
}

/** Validates devices read back from storage (another version, a hand edit): drops what doesn't fit. */
export function sanitizeDevices(raw: unknown): Device[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: Device[] = [];
  for (const d of raw.slice(0, 8)) {
    if (!d || typeof d !== 'object') continue;
    const { id, width, x, y } = d as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(id) || seen.has(id)) continue;
    if (typeof width !== 'number' || width < MIN_DEVICE_WIDTH || width > MAX_DEVICE_WIDTH) continue;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) continue;
    seen.add(id);
    out.push({ id, width: Math.round(width), x: Math.round(x), y: Math.round(y) });
  }
  return out.length ? out : null;
}

// ── marquee selection ────────────────────────────────────────────────────────

export interface Hit {
  id: string;
  /** Ancestor block ids, nearest first. */
  ancestors: string[];
  box: Box;
}

/**
 * Blocks a marquee selects: those fully inside it, without their descendants (selecting a section
 * selects the section, not also everything in it). When nothing is fully inside but the marquee
 * lies within one block, nothing is selected — like design tools, a rectangle must enclose.
 */
export function marqueeSelect(hits: Hit[], marquee: Box): string[] {
  const inside = hits.filter((h) => contains(marquee, h.box));
  const ids = new Set(inside.map((h) => h.id));
  return inside.filter((h) => !h.ancestors.some((a) => ids.has(a))).map((h) => h.id);
}

// ── measurement ──────────────────────────────────────────────────────────────

export interface Gap {
  axis: 'x' | 'y';
  /** Line from (x1, y1) to (x2, y2), in the same space as the boxes. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
}

/**
 * Distances between two boxes, like holding Alt in a design tool: the empty space between them on
 * each axis where they don't overlap, or the inset from the outer box when one contains the other.
 */
export function distances(a: Box, b: Box): Gap[] {
  const out: Gap[] = [];
  const cy = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
  const cx = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
  const midY = Number.isFinite(cy) && Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h) ? cy : a.y + a.h / 2;
  const midX = Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w) ? cx : a.x + a.w / 2;
  if (contains(b, a) || contains(a, b)) {
    const [i, o] = contains(b, a) ? [a, b] : [b, a];
    const mx = i.x + i.w / 2;
    const my = i.y + i.h / 2;
    out.push({ axis: 'x', x1: o.x, y1: my, x2: i.x, y2: my, value: i.x - o.x });
    out.push({ axis: 'x', x1: i.x + i.w, y1: my, x2: o.x + o.w, y2: my, value: o.x + o.w - i.x - i.w });
    out.push({ axis: 'y', x1: mx, y1: o.y, x2: mx, y2: i.y, value: i.y - o.y });
    out.push({ axis: 'y', x1: mx, y1: i.y + i.h, x2: mx, y2: o.y + o.h, value: o.y + o.h - i.y - i.h });
    return out.filter((g) => g.value > 0.5);
  }
  if (a.x + a.w <= b.x) out.push({ axis: 'x', x1: a.x + a.w, y1: midY, x2: b.x, y2: midY, value: b.x - a.x - a.w });
  else if (b.x + b.w <= a.x) out.push({ axis: 'x', x1: b.x + b.w, y1: midY, x2: a.x, y2: midY, value: a.x - b.x - b.w });
  if (a.y + a.h <= b.y) out.push({ axis: 'y', x1: midX, y1: a.y + a.h, x2: midX, y2: b.y, value: b.y - a.y - a.h });
  else if (b.y + b.h <= a.y) out.push({ axis: 'y', x1: midX, y1: b.y + b.h, x2: midX, y2: a.y, value: a.y - b.y - b.h });
  return out;
}
