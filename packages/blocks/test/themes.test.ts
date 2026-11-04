import { describe, expect, it } from 'vitest';
import { contrastRatio, getThemePreset, THEME_CATEGORIES, THEME_PRESETS, themeContrastIssues } from '../src';

describe('theme library', () => {
  it('has a couple of dozen unique presets across every category', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(24);
    expect(new Set(THEME_PRESETS.map((p) => p.key)).size).toBe(THEME_PRESETS.length);
    for (const c of THEME_CATEGORIES) expect(THEME_PRESETS.some((p) => p.category === c)).toBe(true);
    expect(getThemePreset('bakery')?.nameRu).toBe('Пекарня');
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('every preset is readable: text, buttons (white or dark text, whichever reads), links, bands', () => {
    for (const p of THEME_PRESETS) expect(themeContrastIssues(p.colors), p.key).toEqual([]);
    expect(themeContrastIssues({ primary: '#ffff00', background: '#ffffff', foreground: '#aaaaaa', muted: '#ffffff' }).map((i) => i.pair).sort()).toEqual(['link', 'muted', 'text']); // a yellow button gets dark text
  });
});
