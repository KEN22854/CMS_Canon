'use client';

import { ANIMATION_DEFAULTS, ANIMATION_EASINGS, ANIMATION_TYPES, HOVER_EFFECTS, normalizeAnimation, type BlockAnimation, type BlockNode } from '@canon/blocks';
import { Play, Sparkles } from 'lucide-react';
import { useT, type MessageKey } from '@/lib/i18n';
import { useBuilder } from './store';

const field = 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs shadow-sm disabled:opacity-50';

/**
 * Entrance and hover animation of the selected block. The canvas doesn't play entrances while
 * editing (it would flicker on every change); "Preview" replays this block's entrance once.
 */
export function AnimationPanel({ node, readOnly }: { node: BlockNode; readOnly: boolean }) {
  const t = useT();
  const updateNode = useBuilder((s) => s.updateNode);
  const a: BlockAnimation = node.animation ?? {};
  const set = (patch: Partial<BlockAnimation>) => updateNode(node.id, { animation: normalizeAnimation({ ...a, ...patch }) }, `${node.id}.animation.${Object.keys(patch).join(',')}`);

  const preview = () => {
    const el = document.querySelector<HTMLElement>(`[role="application"] [data-block-id="${CSS.escape(node.id)}"]`);
    if (!el || !a.type) return;
    el.removeAttribute('data-anim');
    void el.offsetWidth; // restart the animation
    el.setAttribute('data-anim', a.type);
    window.setTimeout(() => el.removeAttribute('data-anim'), (a.duration ?? ANIMATION_DEFAULTS.duration) + (a.delay ?? 0) + 150);
  };

  return (
    <section className="space-y-2.5 rounded-md border px-3 py-3" aria-label={t('anim.title')}>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden /> {t('anim.title')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">
          {t('anim.entrance')}
          <select className={field} disabled={readOnly} value={a.type ?? ''} onChange={(e) => set({ type: (e.target.value || undefined) as BlockAnimation['type'] })}>
            <option value="">{t('anim.none')}</option>
            {ANIMATION_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`anim.type.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {a.type && (
          <>
            <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">
              {t('anim.trigger')}
              <select className={field} disabled={readOnly} value={a.trigger ?? ANIMATION_DEFAULTS.trigger} onChange={(e) => set({ trigger: e.target.value as BlockAnimation['trigger'] })}>
                <option value="scroll">{t('anim.trigger.scroll')}</option>
                <option value="load">{t('anim.trigger.load')}</option>
              </select>
            </label>
            <label className="space-y-1 text-[11px] text-muted-foreground">
              {t('anim.duration')}
              <input type="number" min={100} max={5000} step={50} className={field} disabled={readOnly} value={a.duration ?? ANIMATION_DEFAULTS.duration} onChange={(e) => set({ duration: Math.min(5000, Math.max(100, Number(e.target.value) || ANIMATION_DEFAULTS.duration)) })} />
            </label>
            <label className="space-y-1 text-[11px] text-muted-foreground">
              {t('anim.delay')}
              <input type="number" min={0} max={10000} step={50} className={field} disabled={readOnly} value={a.delay ?? 0} onChange={(e) => set({ delay: Math.min(10000, Math.max(0, Number(e.target.value) || 0)) })} />
            </label>
            <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">
              {t('anim.easing')}
              <select className={field} disabled={readOnly} value={a.easing ?? ANIMATION_DEFAULTS.easing} onChange={(e) => set({ easing: e.target.value as BlockAnimation['easing'] })}>
                {ANIMATION_EASINGS.map((x) => (
                  <option key={x} value={x}>
                    {t(`anim.easing.${x}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="col-span-2 space-y-1 text-[11px] text-muted-foreground">
          {t('anim.hover')}
          <select className={field} disabled={readOnly} value={a.hover ?? 'none'} onChange={(e) => set({ hover: e.target.value as BlockAnimation['hover'] })}>
            {HOVER_EFFECTS.map((x) => (
              <option key={x} value={x}>
                {t(`anim.hover.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {a.type && (
        <button type="button" onClick={preview} className="flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium hover:bg-muted">
          <Play className="h-3.5 w-3.5" /> {t('anim.preview')}
        </button>
      )}
    </section>
  );
}
