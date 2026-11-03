'use client';

import { useEffect } from 'react';

/**
 * Runs scroll entrances: marks the document ready (only then do scroll-animated blocks start
 * hidden, so without JavaScript everything is visible) and reveals each block once it comes into
 * view. Rendered only on pages that have such blocks.
 */
export function AnimationObserver() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-anim-trigger="scroll"]'));
    if (!els.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.documentElement.classList.add('canon-anim');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).setAttribute('data-anim-in', '');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );
    // Blocks already on screen at load animate right away.
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);
  return null;
}
