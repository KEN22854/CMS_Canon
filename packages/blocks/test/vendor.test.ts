import { describe, expect, it } from 'vitest';
import { SECTION_CATEGORIES, compileStyles, validatePageContent } from '../src';
import { loadVendorSections } from '../src/vendor';

describe('converted open-source templates', () => {
  it('every section validates, fills its text per locale and keeps its attribution', async () => {
    const all = await loadVendorSections();
    expect(all.length).toBeGreaterThan(200);
    expect(new Set(all.map((s) => s.key)).size).toBe(all.length);
    for (const s of all) {
      expect(SECTION_CATEGORIES as readonly string[]).toContain(s.category);
      expect(s.source.license).toBe('MIT');
      for (const locale of ['en', 'ru']) {
        const block = s.build(locale);
        const root = { id: 'root', type: 'section', props: {}, children: [block] };
        const res = validatePageContent({ root });
        expect(res.ok, `${s.key}/${locale}`).toBe(true);
        expect(JSON.stringify(block)).not.toMatch(/\[\[(h1|h2|h3|p|label|btn|link)\]\]/);
        compileStyles(root);
      }
    }
  });

  it('uses only allow-listed stock image hosts and fresh ids per insert', async () => {
    const all = await loadVendorSections();
    const srcs = JSON.stringify(all.map((s) => s.build('en'))).match(/"src":"[^"]+"/g) ?? [];
    expect(srcs.length).toBeGreaterThan(20);
    for (const s of srcs) expect(s).toMatch(/https:\/\/(images\.unsplash\.com|picsum\.photos)\//);
    const one = all[0]!;
    expect(one.build('en').id).not.toBe(one.build('en').id);
    expect(JSON.stringify(one.build('ru'))).toMatch(/[а-я]/);
  });
});
