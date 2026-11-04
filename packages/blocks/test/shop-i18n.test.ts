import { describe, expect, it } from 'vitest';
import { SHOP_STRINGS, shopText } from '../src';

describe('shop strings', () => {
  it('every language has every key, with the same placeholders as English', () => {
    const keys = Object.keys(SHOP_STRINGS.en);
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [lang, dict] of Object.entries(SHOP_STRINGS)) {
      expect(Object.keys(dict).sort(), lang).toEqual([...keys].sort());
      for (const k of keys) expect(vars(dict[k as keyof typeof dict]), `${lang}.${k}`).toEqual(vars(SHOP_STRINGS.en[k as keyof typeof SHOP_STRINGS.en]));
    }
  });

  it('picks the language of a locale and falls back to English', () => {
    expect(shopText('de-AT', 'order', { number: 7 })).toBe('Bestellung Nr. 7');
    expect(shopText('fr', 'total')).toBe('Total');
    expect(shopText('es', 'remove')).toBe('Quitar');
    expect(shopText('ja', 'remove')).toBe('Remove');
    expect(shopText(undefined, 'mailSubject', { shop: 'Bakery', number: 1 })).toBe('Bakery: order #1 received');
  });
});
