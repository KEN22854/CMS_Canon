'use client';

import type { StyleBreakpoint } from '@canon/blocks';
import { Grid3x3, Hand, Magnet, Map as MapIcon, Maximize, Move, Ruler, Minus, MousePointer2, Plus, ScanSearch, Smartphone, Monitor, Tablet, Laptop, X, MoreHorizontal } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { findNode } from '../../editor/tree-ops';
import { CanvasFrame, CanvasStyles, SelectionStatus, useStyledRoot, type FrameProps } from '../canvas';
import type { DropTarget } from '../drop';
import { FreeFormBar, rectOf, topLevelOf } from '../simple';
import { FreeSelection, freeSelection, useFreeKeyboard } from '../free-board';
import { useBlockLabels } from '../labels';
import { useBuilder, useBuilderStore } from '../store';
import { arrange } from './actions';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import {
  DEVICE_PRESETS,
  MAX_DEVICE_WIDTH,
  MIN_DEVICE_WIDTH,
  ZOOM_PRESETS,
  breakpointForWidth,
  clampZoom,
  defaultDevices,
  fitView,
  fitWidthView,
  intersects,
  marqueeSelect,
  nextDevicePosition,
  normalizeBox,
  revealView,
  sanitizeDevices,
  union,
  widthForBreakpoint,
  zoomAt,
  type Box,
  type Device,
  type Hit,
  type View,
} from './geometry';
import { Minimap } from './minimap';
import { Rulers } from './rulers';
import { useDirectFreeDrag } from './free-place';

type Tool = 'select' | 'hand';
const HEADER_H = 30;
const ZOOM_COMMIT_MS = 140;
const storageKey = (pageId: string) => `canon.board.v1.${pageId}`;

const DEVICE_ICON: Record<string, typeof Monitor> = { desktop: Monitor, laptop: Laptop, tablet: Tablet, mobile: Smartphone };

interface Stored {
  devices: Device[];
  view?: View;
}

function readStored(pageId: string): Stored {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey(pageId)) ?? 'null') as { devices?: unknown; view?: Partial<View> } | null;
    const devices = sanitizeDevices(raw?.devices) ?? defaultDevices();
    const v = raw?.view;
    const view = v && [v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) ? { x: v.x!, y: v.y!, zoom: clampZoom(v.zoom!) } : undefined;
    return { devices, view };
  } catch {
    return { devices: defaultDevices() };
  }
}

function writeStored(pageId: string, s: Stored) {
  try {
    window.localStorage.setItem(storageKey(pageId), JSON.stringify(s));
  } catch {
    // Not remembered: the board opens with the default layout next time.
  }
}

/**
 * The infinite canvas. The page is shown on device artboards (Desktop, Tablet, Mobile… side by
 * side) placed on a board you pan and zoom like Miro or FigJam. Every artboard renders the real
 * page with the site's renderers at its own width — container queries make each one show exactly
 * what a visitor with that screen sees — and the artboard you work in edits that breakpoint's
 * styles. Content edits are shared by all of them, as on the live site.
 *
 * The board is only the workspace: the page itself stays a responsive layout of sections,
 * containers, flex and grid, saved through the same API and published by the same renderer.
 *
 * Panning never re-renders React (the world layer is moved directly); zooming previews with a CSS
 * transform while the wheel turns and lays the artboards out at the new zoom once it stops.
 */
export function Board(props: FrameProps & { hostRef: React.RefObject<HTMLDivElement | null>; drop: DropTarget | null }) {
  const { pageId, siteId, readOnly, hostRef } = props;
  const t = useT();
  const L = useBlockLabels();
  const store = useBuilderStore();
  const breakpoint = useBuilder((s) => s.breakpoint);
  const selectedIds = useBuilder((s) => s.selectedIds);
  const selectedNode = useBuilder((s) => (s.selectedId ? findNode(s.draft.content.root, s.selectedId) : null));
  const showGrid = useBuilder((s) => s.grid);
  const snapOn = useBuilder((s) => s.snap);
  const freeOn = useBuilder((s) => s.freePlacement);
  const focus = useBuilder((s) => s.focus);
  const styledRoot = useStyledRoot(siteId);

  const [initial] = useState(() => readStored(pageId));
  const [devices, setDevices] = useState<Device[]>(initial.devices);
  const [activeId, setActiveId] = useState<string>(() => initial.devices.find((d) => breakpointForWidth(d.width) === store.getState().breakpoint)?.id ?? initial.devices[0]!.id);
  const [zoom, setZoomState] = useState(initial.view?.zoom ?? 0.5);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [tool, setTool] = useState<Tool>('select');
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [minimap, setMinimap] = useState(true);
  const [rulers, setRulers] = useState(true);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>(initial.view ?? { x: 40, y: 60, zoom: 0.5 });
  const committed = useRef(zoom);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listeners = useRef(new Set<(v: View) => void>());
  const suppressClick = useRef(false);
  const fitted = useRef(Boolean(initial.view));

  const active = devices.find((d) => d.id === activeId) ?? devices[0]!;
  const activeBp = breakpointForWidth(active.width);

  /** Moves the world layer to `v` without a React render; zoom changes commit after a pause. */
  const applyView = useCallback((v: View, commitNow = false) => {
    view.current = v;
    const world = worldRef.current;
    const vp = viewportRef.current;
    if (world) world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom / committed.current})`;
    if (vp) {
      // The dot grid moves and scales with the board.
      const step = 24 * v.zoom;
      vp.style.backgroundSize = `${step}px ${step}px`;
      vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
    }
    for (const l of listeners.current) l(v);
    if (Math.abs(v.zoom - committed.current) > 1e-6) {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      const commit = () => {
        commitTimer.current = null;
        committed.current = view.current.zoom;
        setZoomState(view.current.zoom);
      };
      if (commitNow) commit();
      else commitTimer.current = setTimeout(commit, ZOOM_COMMIT_MS);
    }
  }, []);

  // After a zoom commit the artboards are laid out at the new zoom: drop the preview scale.
  useLayoutEffect(() => {
    applyView(view.current);
  }, [zoom, applyView]);

  const subscribe = useCallback((fn: (v: View) => void) => {
    listeners.current.add(fn);
    fn(view.current);
    return () => void listeners.current.delete(fn);
  }, []);

  // Remember the layout and view per page (a per-viewer convenience, not page data).
  useEffect(() => {
    const save = () => writeStored(pageId, { devices, view: view.current });
    const id = setInterval(save, 2000);
    window.addEventListener('beforeunload', save);
    return () => {
      clearInterval(id);
      window.removeEventListener('beforeunload', save);
      save();
    };
  }, [pageId, devices]);

  // The artboard you work in edits its breakpoint.
  useEffect(() => {
    if (store.getState().breakpoint !== activeBp) store.getState().setBreakpoint(activeBp);
  }, [activeBp, store]);

  // Picked another breakpoint in the top bar: work on its artboard (adding one if there is none).
  useEffect(() => {
    if (breakpoint === activeBp) return;
    const match = devices.find((d) => breakpointForWidth(d.width) === breakpoint);
    if (match) setActiveId(match.id);
    else {
      const d: Device = { id: `bp-${breakpoint.toLowerCase()}`, width: widthForBreakpoint(breakpoint), ...nextDevicePosition(devices) };
      setDevices((list) => [...list, d]);
      setActiveId(d.id);
    }
    // Only a change of the store's breakpoint matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakpoint]);

  const boundsOf = useCallback((list: Device[]): Box => union(list.map((d) => ({ x: d.x, y: d.y - HEADER_H / Math.max(0.05, view.current.zoom), w: d.width, h: (heights[d.id] ?? 900) + HEADER_H / Math.max(0.05, view.current.zoom) })))!, [heights]);

  const viewportSize = () => {
    const r = viewportRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1200, h: r?.height ?? 800 };
  };

  const zoomToFit = useCallback(() => {
    const { w, h } = viewportSize();
    applyView(fitView(boundsOf(devices), w, h, 64, 1), true);
  }, [applyView, boundsOf, devices]);

  /** World box of a block on the active artboard. */
  const worldBoxOf = useCallback(
    (id: string): Box | null => {
      const host = hostRef.current;
      const vp = viewportRef.current;
      const el = host?.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (!el || !vp) return null;
      const r = el.getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      const v = view.current;
      return { x: (r.left - vr.left - v.x) / v.zoom, y: (r.top - vr.top - v.y) / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom };
    },
    [hostRef],
  );

  const selectionBox = useCallback(() => union(store.getState().selectedIds.flatMap((id) => worldBoxOf(id) ?? [])), [store, worldBoxOf]);

  const zoomToSelection = useCallback(() => {
    const boxes = store.getState().selectedIds.flatMap((id) => worldBoxOf(id) ?? []);
    const box = union(boxes);
    if (!box) return zoomToFit();
    const { w, h } = viewportSize();
    applyView(fitView(box, w, h, 80, 2), true);
  }, [store, worldBoxOf, zoomToFit, applyView]);

  const zoomBy = useCallback(
    (factor: number) => {
      const { w, h } = viewportSize();
      applyView(zoomAt(view.current, factor, w / 2, h / 2), true);
    },
    [applyView],
  );
  const zoomTo = useCallback(
    (z: number) => {
      const { w, h } = viewportSize();
      applyView(zoomAt(view.current, z / view.current.zoom, w / 2, h / 2), true);
    },
    [applyView],
  );

  // First visit of this page's board: fit everything once the artboards have a height.
  useEffect(() => {
    if (fitted.current || !Object.keys(heights).length) return;
    fitted.current = true;
    const { w } = viewportSize();
    applyView(fitWidthView(boundsOf(devices), w, 64), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heights]);

  // A layer was picked (or another request): bring the block into view, panning as little as possible.
  useEffect(() => {
    if (!focus) return;
    const raf = requestAnimationFrame(() => {
      const box = worldBoxOf(focus.id);
      if (!box) return;
      const { w, h } = viewportSize();
      const next = revealView(view.current, box, w, h);
      if (next) applyView(next, true);
    });
    return () => cancelAnimationFrame(raf);
  }, [focus, worldBoxOf, applyView]);

  // Wheel: pan; Ctrl/⌘ + wheel or a trackpad pinch: zoom around the pointer.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('[data-board-scroll]')) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * unit * 0.0025);
        applyView(zoomAt(view.current, factor, e.clientX - r.left, e.clientY - r.top));
      } else {
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        applyView({ ...view.current, x: view.current.x - dx, y: view.current.y - dy });
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [applyView]);

  // Board shortcuts: V / H tools, hold Space to pan, Shift+1 fit, Shift+2 selection, Ctrl +/−/0 zoom, Ctrl+]/[ order.
  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const x = el as HTMLElement | null;
      return Boolean(x && (x.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName)));
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        setSpace(true);
      } else if (!mod && !e.altKey && k === 'v') setTool('select');
      else if (!mod && !e.altKey && k === 'h' && !e.shiftKey) setTool('hand');
      else if (!mod && e.shiftKey && k === 'r') setRulers((x) => !x);
      else if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        zoomToFit();
      }
      else if (e.shiftKey && e.code === 'Digit2') {
        e.preventDefault();
        zoomToSelection();
      }
      else if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        zoomBy(1.25);
      }
      else if (mod && k === '-') {
        e.preventDefault();
        zoomBy(0.8);
      }
      else if (mod && k === '0') {
        e.preventDefault();
        zoomTo(1);
      }
      else if (mod && !readOnly && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        arrange(store, e.key === ']' ? 1 : -1);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false);
    const blur = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [zoomToFit, zoomToSelection, zoomBy, zoomTo, store, readOnly]);

  const panMode = tool === 'hand' || space;

  /** Drag the board: middle button anywhere, or the hand tool / Space + drag. */
  const startPan = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, v: view.current };
    let moved = false;
    setPanning(true);
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 3) moved = true;
      applyView({ ...start.v, x: start.v.x + ev.clientX - start.x, y: start.v.y + ev.clientY - start.y });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPanning(false);
      // The click that ends a pan must not select what is under the pointer.
      suppressClick.current = moved;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Rectangle selection, started on the empty board. */
  const startMarquee = (e: React.PointerEvent) => {
    const vp = viewportRef.current!;
    const vr = vp.getBoundingClientRect();
    const a = { x: e.clientX - vr.left, y: e.clientY - vr.top };
    let box: Box | null = null;
    const move = (ev: PointerEvent) => {
      box = normalizeBox(a, { x: ev.clientX - vr.left, y: ev.clientY - vr.top });
      setMarquee(box.w + box.h > 4 ? box : null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
      const s = store.getState();
      if (!box || box.w + box.h <= 4) {
        if (!ev.shiftKey) s.select(null);
        return;
      }
      // The artboard the rectangle covers most is the one selected in (and becomes active).
      const boards = [...vp.querySelectorAll<HTMLElement>('[data-artboard]')].map((el) => {
        const r = el.getBoundingClientRect();
        const b = { x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height };
        const ix = Math.max(0, Math.min(b.x + b.w, box!.x + box!.w) - Math.max(b.x, box!.x));
        const iy = Math.max(0, Math.min(b.y + b.h, box!.y + box!.h) - Math.max(b.y, box!.y));
        return { el, area: intersects(b, box!) ? ix * iy : 0 };
      });
      const best = boards.sort((x, y) => y.area - x.area)[0];
      if (!best || best.area === 0) return void (!ev.shiftKey && s.select(null));
      const rootId = s.draft.content.root.id;
      const hits: Hit[] = [...best.el.querySelectorAll<HTMLElement>('[data-block-id]')]
        .filter((el) => el.dataset.blockId !== rootId)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const ancestors: string[] = [];
          for (let p = el.parentElement?.closest<HTMLElement>('[data-block-id]'); p; p = p.parentElement?.closest<HTMLElement>('[data-block-id]')) ancestors.push(p.dataset.blockId!);
          return { id: el.dataset.blockId!, ancestors, box: { x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height } };
        });
      const ids = marqueeSelect(hits, box);
      const deviceId = best.el.dataset.artboard!;
      if (deviceId !== activeId) setActiveId(deviceId);
      s.selectMany(ev.shiftKey ? [...new Set([...s.selectedIds, ...ids])] : ids);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && panMode)) return startPan(e);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || panMode) return;
    const target = e.target as Element;
    // On the empty board (not an artboard, not the board's own controls): rectangle selection.
    if (target.closest('[data-artboard], [data-builder-ui], [data-board-ui]')) return;
    e.preventDefault();
    startMarquee(e);
  };

  // Moving an artboard by its title bar.
  const startMoveDevice = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || panMode) return;
    e.preventDefault();
    e.stopPropagation();
    const d = devices.find((x) => x.id === id)!;
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const z = view.current.zoom;
      const dx = (ev.clientX - start.x) / z;
      const dy = (ev.clientY - start.y) / z;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      setDevices((list) => list.map((x) => (x.id === id ? { ...x, x: Math.round(d.x + dx), y: Math.round(d.y + dy) } : x)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) setActiveId(id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addDevice = (width: number, presetId?: string) => {
    const w = Math.max(MIN_DEVICE_WIDTH, Math.min(MAX_DEVICE_WIDTH, Math.round(width)));
    const base = presetId ?? `w${w}`;
    let id = base;
    for (let i = 2; devices.some((d) => d.id === id); i++) id = `${base}-${i}`;
    const d: Device = { id, width: w, ...nextDevicePosition(devices) };
    setDevices((list) => [...list, d]);
    setActiveId(d.id);
    requestAnimationFrame(() => {
      const { w: vw, h: vh } = viewportSize();
      const next = revealView(view.current, { x: d.x, y: d.y, w: d.width, h: Math.min(900, heights[active.id] ?? 900) }, vw, vh);
      if (next) applyView(next, true);
    });
  };
  const removeDevice = (id: string) => {
    if (devices.length <= 1) return;
    const rest = devices.filter((d) => d.id !== id);
    setDevices(rest);
    if (activeId === id) setActiveId(rest[0]!.id);
  };
  const resizeDevice = (id: string, width: number) => {
    const w = Math.max(MIN_DEVICE_WIDTH, Math.min(MAX_DEVICE_WIDTH, Math.round(width)));
    setDevices((list) => {
      const i = list.findIndex((d) => d.id === id);
      if (i < 0) return list;
      const old = list[i]!;
      // Artboards to the right make room (or close the gap) so nothing overlaps.
      return list.map((d) => (d.id === id ? { ...d, width: w } : d.x > old.x && Math.abs(d.y - old.y) < 2000 ? { ...d, x: d.x + (w - old.width) } : d));
    });
  };

  const onHeight = useCallback((id: string, h: number) => setHeights((cur) => (Math.abs((cur[id] ?? 0) - h) < 1 ? cur : { ...cur, [id]: h })), []);

  const boardMenu: MenuItem[] = [
    { key: 'fit', label: t('board.zoomFit'), icon: Maximize, shortcut: '⇧1', onSelect: zoomToFit },
    { key: 'sel', label: t('board.zoomSelection'), icon: ScanSearch, shortcut: '⇧2', onSelect: zoomToSelection },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <CanvasStyles root={styledRoot} />
      <div
        ref={viewportRef}
        data-board=""
        aria-label={t('board.label')}
        className={cn('relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-[hsl(var(--board-bg))]', panMode && (panning ? 'cursor-grabbing' : 'cursor-grab'))}
        style={{ backgroundImage: 'radial-gradient(hsl(var(--board-dot)) 1px, transparent 1.2px)' }}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onPointerDown}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        onContextMenu={(e) => {
          if ((e.target as Element).closest('[data-artboard], [data-builder-ui], [data-board-ui]')) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, blockId: null });
        }}
        onMouseLeave={() => store.getState().hover(null)}
        // Something scrolled the board element itself (scrollIntoView, focus): turn it into a pan.
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!el.scrollTop && !el.scrollLeft) return;
          const v = view.current;
          const next = { ...v, x: v.x - el.scrollLeft, y: v.y - el.scrollTop };
          el.scrollTop = 0;
          el.scrollLeft = 0;
          applyView(next, true);
        }}
      >
        <div ref={worldRef} className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ pointerEvents: panMode ? 'none' : undefined }}>
          {devices.map((d) => (
            <Artboard
              key={d.id}
              device={d}
              zoom={zoom}
              active={d.id === active.id}
              frame={props}
              showGrid={showGrid}
              onActivate={(blockId) => {
                setActiveId(d.id);
                if (blockId) store.getState().select(blockId);
              }}
              onContextMenu={readOnly ? undefined : (e, id) => setMenu({ x: e.clientX, y: e.clientY, blockId: id })}
              onHeight={onHeight}
              onMoveStart={startMoveDevice(d.id)}
              onRemove={devices.length > 1 ? () => removeDevice(d.id) : undefined}
              onResize={(w) => resizeDevice(d.id, w)}
              label={deviceLabel(t, d)}
              bpLabel={L.bp(breakpointForWidth(d.width))}
            />
          ))}
        </div>
        {rulers && <Rulers subscribe={subscribe} origin={{ x: active.x, y: active.y }} selection={selectionBox} size={viewportSize} />}
        {marquee && <div className="pointer-events-none absolute z-30 rounded-sm border border-primary bg-primary/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}

        {/* Floating tools: bottom centre. */}
        <div data-board-ui className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border bg-card/95 p-1 shadow-lg backdrop-blur" role="toolbar" aria-label={t('board.tools')}>
          <ToolBtn label={t('board.tool.select')} shortcut="V" pressed={tool === 'select'} onClick={() => setTool('select')}>
            <MousePointer2 className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn label={t('board.tool.hand')} shortcut="H" pressed={tool === 'hand'} onClick={() => setTool('hand')}>
            <Hand className="h-4 w-4" />
          </ToolBtn>
          <Sep />
          <DeviceMenu onAdd={addDevice} />
          <Sep />
          <ToolBtn label={t('board.free')} pressed={freeOn} onClick={() => store.getState().setFreePlacement(!freeOn)}>
            <Move className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn label={t('board.grid')} pressed={showGrid} onClick={() => store.getState().setGrid(!showGrid)}>
            <Grid3x3 className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn label={t('board.snap')} pressed={snapOn} onClick={() => store.getState().setSnap(!snapOn)}>
            <Magnet className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn label={t('board.rulers')} shortcut="⇧R" pressed={rulers} onClick={() => setRulers(!rulers)}>
            <Ruler className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn label={t('board.minimap')} pressed={minimap} onClick={() => setMinimap(!minimap)}>
            <MapIcon className="h-4 w-4" />
          </ToolBtn>
        </div>

        {/* Zoom: bottom right, above the minimap. */}
        <div data-board-ui className="absolute bottom-4 right-4 z-40 flex flex-col items-end gap-2">
          {minimap && <Minimap devices={devices} heights={heights} activeId={active.id} subscribe={subscribe} viewport={viewportSize} onNavigate={(v) => applyView(v, true)} />}
          <div className="flex items-center gap-0.5 rounded-xl border bg-card/95 p-1 shadow-lg backdrop-blur" role="group" aria-label={t('builder.zoom')}>
            <ToolBtn label={t('builder.zoomOut')} onClick={() => zoomBy(0.8)}>
              <Minus className="h-4 w-4" />
            </ToolBtn>
            <ZoomMenu subscribe={subscribe} onZoom={zoomTo} onFit={zoomToFit} onSelection={zoomToSelection} />
            <ToolBtn label={t('builder.zoomIn')} onClick={() => zoomBy(1.25)}>
              <Plus className="h-4 w-4" />
            </ToolBtn>
            <ToolBtn label={t('board.zoomFit')} shortcut="⇧1" onClick={zoomToFit}>
              <Maximize className="h-4 w-4" />
            </ToolBtn>
          </div>
        </div>

        {/* Status: bottom left. */}
        <div data-board-ui className="pointer-events-none absolute bottom-4 left-4 z-40 flex max-w-[calc(50%-250px)] items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg border bg-card/90 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow backdrop-blur">
          <span className="font-medium text-foreground">{deviceLabel(t, active)}</span>
          <span>
            · {active.width}px · {t('board.editing', { bp: L.bp(activeBp) })}
          </span>
          <SelectionStatus count={selectedIds.length} node={selectedNode} />
        </div>
      </div>
      {menu && <ContextMenu state={menu} siteId={siteId} pageId={pageId} onClose={() => setMenu(null)} extra={boardMenu} />}
    </div>
  );
}

const deviceLabel = (t: ReturnType<typeof useT>, d: Device) => {
  const preset = DEVICE_PRESETS.find((p) => d.id === p.id || d.id.startsWith(`${p.id}-`));
  return preset ? t(`board.device.${preset.id}`) : t('board.device.custom');
};

/** One device artboard on the board: title bar (move, activate, width, remove) and the page. */
const Artboard = memo(function Artboard({
  device,
  zoom,
  active,
  frame,
  showGrid,
  onActivate,
  onContextMenu,
  onHeight,
  onMoveStart,
  onRemove,
  onResize,
  label,
  bpLabel,
}: {
  device: Device;
  zoom: number;
  active: boolean;
  frame: FrameProps & { hostRef: React.RefObject<HTMLDivElement | null>; drop: DropTarget | null };
  showGrid: boolean;
  onActivate: (blockId: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, id: string | null) => void;
  onHeight: (id: string, h: number) => void;
  onMoveStart: (e: React.PointerEvent) => void;
  onRemove?: () => void;
  onResize: (w: number) => void;
  label: string;
  bpLabel: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = DEVICE_ICON[DEVICE_PRESETS.find((p) => device.id === p.id || device.id.startsWith(`${p.id}-`))?.id ?? ''] ?? Monitor;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(device.id, el.getBoundingClientRect().height / zoom));
    ro.observe(el);
    return () => ro.disconnect();
  }, [device.id, zoom, onHeight]);
  const bp = breakpointForWidth(device.width) as StyleBreakpoint;
  return (
    <div className="absolute" style={{ left: device.x * zoom, top: device.y * zoom, width: device.width * zoom }} data-artboard={device.id} data-artboard-bp={bp} data-artboard-width={device.width}>
      <div data-board-ui className="absolute bottom-full left-0 flex w-full min-w-0 items-center gap-1.5 overflow-hidden pb-1.5 text-xs" style={{ height: HEADER_H }}>
        <button type="button" onPointerDown={onMoveStart} className={cn('flex min-w-0 cursor-grab items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium active:cursor-grabbing', active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')} title={t('board.artboardHint')} aria-pressed={active} aria-label={t('board.artboard', { name: label, width: device.width })}>
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
        {device.width * zoom >= 230 && (
          <span className="truncate tabular-nums text-muted-foreground">
            {device.width}px · {bpLabel}
          </span>
        )}
        <div className="relative ml-auto shrink-0">
          <button type="button" aria-label={t('board.artboardMenu', { name: label })} onClick={() => setMenuOpen(!menuOpen)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && <ArtboardMenu width={device.width} onResize={(w) => (onResize(w), setMenuOpen(false))} onRemove={onRemove && (() => (onRemove(), setMenuOpen(false)))} onClose={() => setMenuOpen(false)} />}
        </div>
      </div>
      <div ref={ref} className={cn('relative rounded-sm shadow-[0_1px_3px_rgba(0,0,0,0.12),0_8px_32px_-8px_rgba(0,0,0,0.18)] transition-shadow', active ? 'ring-2 ring-primary/70' : 'ring-1 ring-border hover:ring-primary/40')}>
        <CanvasFrame
          {...frame}
          hostRef={frame.hostRef}
          drop={active ? frame.drop : null}
          bp={bp}
          width={device.width}
          scale={zoom}
          active={active}
          onActivate={onActivate}
          onContextMenu={onContextMenu}
          overlay={({ hostRef, scale }) => <BoardOverlay hostRef={hostRef} scale={scale} readOnly={frame.readOnly} />}
          className="min-h-[480px]"
        />
        {showGrid && <LayoutGrid width={device.width} zoom={zoom} />}
      </div>
    </div>
  );
});

/** Layout guides: 12 columns over the content width (4 on phones), like a design tool's layout grid. */
function LayoutGrid({ width, zoom }: { width: number; zoom: number }) {
  const cols = width < 640 ? 4 : width < 1024 ? 8 : 12;
  const margin = width < 640 ? 16 : 24;
  const content = Math.min(width - margin * 2, 1200);
  const left = (width - content) / 2;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-y-0 z-10 flex gap-[var(--g)]" style={{ left: left * zoom, width: content * zoom, ['--g' as string]: `${24 * zoom}px` }}>
      {Array.from({ length: cols }, (_, i) => (
        <div key={i} className="h-full flex-1 bg-pink-500/[0.07] outline outline-1 outline-pink-500/15" />
      ))}
    </div>
  );
}

/** The active artboard's free-form controls (move, resize, rotate, align elements of free-form blocks). */
function BoardOverlay({ hostRef, scale, readOnly }: { hostRef: React.RefObject<HTMLDivElement | null>; scale: number; readOnly: boolean }) {
  const store = useBuilderStore();
  const root = useBuilder((s) => s.draft.content.root);
  const selectedId = useBuilder((s) => s.selectedId);
  const selectedIds = useBuilder((s) => s.selectedIds);
  const breakpoint = useBuilder((s) => s.breakpoint);
  const [tick, setTick] = useState(0);
  const free = freeSelection(root, selectedIds);
  const top = topLevelOf(root, selectedId);
  const freeBlock = top?.type === 'canvas' ? top : null;
  const [rect, setRect] = useState<ReturnType<typeof rectOf>>(null);
  useFreeKeyboard(store, hostRef, readOnly);
  useDirectFreeDrag(store, hostRef, readOnly);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !freeBlock) return setRect(null);
    const update = () => setRect(rectOf(host, freeBlock.id));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef, freeBlock, root, breakpoint, scale, tick]);
  if (readOnly) return null;
  return (
    <>
      {freeBlock && rect && <FreeFormBar node={freeBlock} rect={rect} breakpoint={breakpoint} hostRef={hostRef} scale={scale} onChange={() => setTick((n) => n + 1)} />}
      {free && <FreeSelection key={free.ids.join(',') + tick} canvas={free.canvas} ids={free.ids} hostRef={hostRef} scale={scale} breakpoint={breakpoint} store={store} onDone={() => setTick((n) => n + 1)} />}
    </>
  );
}

function ArtboardMenu({ width, onResize, onRemove, onClose }: { width: number; onResize: (w: number) => void; onRemove?: () => void; onClose: () => void }) {
  const t = useT();
  const [custom, setCustom] = useState(String(width));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  return (
    <div ref={ref} data-board-ui className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-card p-1 text-xs shadow-xl" role="menu">
      {DEVICE_PRESETS.map((p) => (
        <button key={p.id} type="button" role="menuitemradio" aria-checked={p.width === width} onClick={() => onResize(p.width)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 hover:bg-muted">
          <span>{t(`board.device.${p.id}`)}</span>
          <span className="tabular-nums text-muted-foreground">{p.width}px</span>
        </button>
      ))}
      <form
        className="flex items-center gap-1 border-t px-1 pt-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(custom);
          if (Number.isFinite(n)) onResize(n);
        }}
      >
        <label className="flex-1">
          <span className="sr-only">{t('board.customWidth')}</span>
          <input type="number" min={MIN_DEVICE_WIDTH} max={MAX_DEVICE_WIDTH} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t('board.customWidth')} className="h-7 w-full rounded border border-input bg-background px-2 tabular-nums" />
        </label>
        <button type="submit" className="h-7 rounded bg-primary px-2 font-medium text-primary-foreground">
          {t('board.apply')}
        </button>
      </form>
      {onRemove && (
        <button type="button" onClick={onRemove} className="mt-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-destructive hover:bg-muted">
          <X className="h-3.5 w-3.5" /> {t('board.removeArtboard')}
        </button>
      )}
    </div>
  );
}

function DeviceMenu({ onAdd }: { onAdd: (width: number, presetId?: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('1024');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:bg-muted">
        <Plus className="h-3.5 w-3.5" /> {t('board.addArtboard')}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-56 rounded-lg border bg-card p-1 text-xs shadow-xl" role="menu">
          {DEVICE_PRESETS.map((p) => {
            const Icon = DEVICE_ICON[p.id] ?? Monitor;
            return (
              <button key={p.id} type="button" role="menuitem" onClick={() => (onAdd(p.width, p.id), setOpen(false))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 text-left">{t(`board.device.${p.id}`)}</span>
                <span className="tabular-nums text-muted-foreground">{p.width}px</span>
              </button>
            );
          })}
          <form
            className="flex items-center gap-1 border-t px-1 pt-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(custom);
              if (Number.isFinite(n)) {
                onAdd(n);
                setOpen(false);
              }
            }}
          >
            <input type="number" min={MIN_DEVICE_WIDTH} max={MAX_DEVICE_WIDTH} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t('board.customWidth')} className="h-7 w-full flex-1 rounded border border-input bg-background px-2 tabular-nums" />
            <button type="submit" className="h-7 rounded bg-primary px-2 font-medium text-primary-foreground">
              {t('board.add')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function ZoomMenu({ subscribe, onZoom, onFit, onSelection }: { subscribe: (fn: (v: View) => void) => () => void; onZoom: (z: number) => void; onFit: () => void; onSelection: () => void }) {
  const t = useT();
  const [z, setZ] = useState(1);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => subscribe((v) => setZ(v.zoom)), [subscribe]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-label={t('board.zoomLevel')} aria-expanded={open} className="h-8 w-14 rounded-lg text-center text-xs font-medium tabular-nums hover:bg-muted" data-zoom-level>
        {Math.round(z * 100)}%
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-44 rounded-lg border bg-card p-1 text-xs shadow-xl" role="menu">
          {ZOOM_PRESETS.map((p) => (
            <button key={p} type="button" role="menuitem" onClick={() => (onZoom(p), setOpen(false))} className="flex w-full justify-between rounded-md px-2 py-1.5 hover:bg-muted">
              {Math.round(p * 100)}%{p === 1 && <kbd className="text-[10px] text-muted-foreground">Ctrl+0</kbd>}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button type="button" role="menuitem" onClick={() => (onFit(), setOpen(false))} className="flex w-full justify-between rounded-md px-2 py-1.5 hover:bg-muted">
            {t('board.zoomFit')} <kbd className="text-[10px] text-muted-foreground">⇧1</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => (onSelection(), setOpen(false))} className="flex w-full justify-between rounded-md px-2 py-1.5 hover:bg-muted">
            {t('board.zoomSelection')} <kbd className="text-[10px] text-muted-foreground">⇧2</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

function ToolBtn({ label, shortcut, pressed, onClick, children }: { label: string; shortcut?: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={shortcut ? `${label} (${shortcut})` : label} aria-pressed={pressed} onClick={onClick} className={cn('grid h-8 w-8 place-items-center rounded-lg transition-colors', pressed ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-5 w-px bg-border" />;

