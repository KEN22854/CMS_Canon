'use client';

import { useEffect } from 'react';

interface TrackEvent {
  type: 'pageview' | 'event' | 'engagement';
  path: string;
  title?: string;
  name?: string;
  props?: Record<string, string | number | boolean>;
  durationMs?: number;
}

declare global {
  interface Window {
    canon?: { track: (name: string, props?: TrackEvent['props']) => void };
  }
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
}

const FLUSH_MS = 5_000;

/**
 * First-party, cookie-scoped analytics: page views, engaged time, CTA clicks and custom events
 * (`window.canon.track('signup')`). Honors Global Privacy Control and Do Not Track by sending
 * nothing at all. Identity lives in httpOnly cookies the proxy set; this script never sees it.
 */
export function Tracker({ siteId, path, title, experiments }: { siteId: string; path: string; title: string; experiments: { testId: string; variantId: string }[] }) {
  useEffect(() => {
    if (navigator.globalPrivacyControl || navigator.doNotTrack === '1') {
      window.canon = { track: () => undefined };
      return;
    }
    let queue: TrackEvent[] = [];
    let visibleSince = document.visibilityState === 'visible' ? performance.now() : null;
    let engaged = 0;

    const flush = (final = false) => {
      if (visibleSince !== null && final) {
        engaged += performance.now() - visibleSince;
        visibleSince = null;
      }
      if (final && engaged >= 1_000) queue.push({ type: 'engagement', path, durationMs: Math.round(engaged) }), (engaged = 0);
      if (!queue.length) return;
      const body = JSON.stringify({ siteId, events: queue.slice(0, 50), referrer: document.referrer || undefined, experiments: experiments.length ? experiments : undefined });
      queue = queue.slice(50);
      const blob = new Blob([body], { type: 'application/json' });
      if (!(final && navigator.sendBeacon?.('/api/collect', blob))) void fetch('/api/collect', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined);
    };

    const track = (name: string, props?: TrackEvent['props']) => {
      if (!/^[a-z0-9_.:-]{1,64}$/i.test(name)) return;
      queue.push({ type: 'event', name, path, props });
    };
    window.canon = { track };
    queue.push({ type: 'pageview', path, title });
    flush();

    // Declarative events: <a data-canon-event="cta_click">.
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-canon-event]') as HTMLElement | null;
      if (!el) return;
      const href = el.getAttribute('href');
      track(el.dataset.canonEvent!, href ? { href: href.slice(0, 200) } : undefined);
      flush(); // the click may navigate away
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush(true);
      else visibleSince = performance.now();
    };
    const onHide = () => flush(true);
    const timer = setInterval(() => flush(), FLUSH_MS);
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      flush(true);
      clearInterval(timer);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
    };
  }, [siteId, path, title, experiments]);
  return null;
}
