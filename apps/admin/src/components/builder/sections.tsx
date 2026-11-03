'use client';

import { SECTION_CATEGORIES, SECTION_PRESETS, SECTION_TONES, type SectionTone } from '@canon/blocks';
import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { useLocale, useT, translate, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useBuilder } from './store';

const TONE_SWATCH: Record<SectionTone, string> = {
  light: 'bg-white ring-1 ring-border',
  muted: 'bg-slate-200',
  dark: 'bg-slate-900',
  brand: 'bg-gradient-to-br from-[#8B7CFF] to-[#42C8E8]',
};

/** Ready-made sections (Stage 4): pick a tone, click a layout; it lands as regular, editable blocks. */
export function SectionLibrary({ locale, filter }: { locale: string; filter: (...texts: string[]) => boolean }) {
  const t = useT();
  const ui = useLocale();
  const insert = useBuilder((s) => s.insert);
  const [tone, setTone] = useState<SectionTone>('light');
  const name = (key: string, fallback: string) => translate(ui, `section.${key}` as MessageKey) || fallback;
  const groups = SECTION_CATEGORIES.map((c) => ({ c, items: SECTION_PRESETS.filter((p) => p.category === c && filter(name(p.key, ui === 'ru' && p.nameRu ? p.nameRu : p.name), p.name, p.description)) })).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t('palette.sections')}</p>
        <p className="text-[10px] text-muted-foreground">{t('palette.sectionsHint')}</p>
      </div>
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label={t('section.tone')}>
        {SECTION_TONES.map((x) => (
          <button key={x} type="button" role="radio" aria-checked={tone === x} title={t(`section.tone.${x}`)} aria-label={t(`section.tone.${x}`)} onClick={() => setTone(x)} className={cn('h-5 w-5 rounded-full', TONE_SWATCH[x], tone === x && 'ring-2 ring-primary ring-offset-2 ring-offset-background')} />
        ))}
        <span className="ml-1 text-[10px] text-muted-foreground">{t(`section.tone.${tone}`)}</span>
      </div>
      {groups.map(({ c, items }) => (
        <div key={c}>
          <p className="mb-1 text-[10px] font-medium text-muted-foreground">{t(`section.cat.${c}`)}</p>
          <div className="grid grid-cols-1 gap-1">
            {items.map((p) => (
              <button key={p.key} type="button" title={p.description} onClick={() => insert(p.build(locale, tone))} className="flex items-center gap-1.5 rounded-md border border-dashed bg-card px-2 py-1.5 text-left text-xs font-medium hover:border-primary hover:text-primary">
                <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate">{name(p.key, ui === 'ru' && p.nameRu ? p.nameRu : p.name)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
