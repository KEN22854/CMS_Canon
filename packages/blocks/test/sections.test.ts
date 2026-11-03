import { describe, expect, it } from 'vitest';
import { SECTION_CATEGORIES, SECTION_PRESETS, SECTION_TONES, compileStyles, validatePageContent } from '../src';

describe('section library', () => {
  it('has unique keys in every category', () => {
    expect(new Set(SECTION_PRESETS.map((p) => p.key)).size).toBe(SECTION_PRESETS.length);
    for (const c of SECTION_CATEGORIES) expect(SECTION_PRESETS.some((p) => p.category === c), c).toBe(true);
  });

  it('every layout, tone and language passes page validation and compiles its styles', () => {
    for (const p of SECTION_PRESETS) {
      for (const tone of SECTION_TONES) {
        for (const locale of ['en', 'ru']) {
          const root = { id: 'root', type: 'section', props: {}, children: [p.build(locale, tone)] };
          const res = validatePageContent({ root });
          expect(res.ok, `${p.key}/${tone}/${locale}: ${res.ok ? '' : JSON.stringify(res.issues.slice(0, 3))}`).toBe(true);
          compileStyles(root);
        }
      }
    }
  });

  it('builds fresh ids every time and localises copy', () => {
    const hero = SECTION_PRESETS.find((p) => p.key === 'hero-centered')!;
    expect(hero.build('en', 'light').id).not.toBe(hero.build('en', 'light').id);
    expect(hero.build('ru', 'light').props.title).toBe('Запустите новую идею быстрее');
  });

  it('tones change the look', () => {
    const p = SECTION_PRESETS.find((x) => x.key === 'features-3')!;
    const looks = new Set(SECTION_TONES.map((t) => JSON.stringify(p.build('en', t).styles)));
    expect(looks.size).toBe(SECTION_TONES.length);
  });
});
