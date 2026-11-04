import { describe, expect, it } from 'vitest';
import { bindEntry, collectProductIds, formatMoney, hasCart, toMinor, validatePageContent, type BlockNode } from '../src';

const n = (id: string, type: string, props: Record<string, unknown>, children: BlockNode[] = []): BlockNode => ({ id, type, props, children });

describe('shop', () => {
  it('keeps money in minor units and formats it for the visitor', () => {
    expect(toMinor(4.5)).toBe(450);
    expect(toMinor(0.1 + 0.2)).toBe(30); // no floating-point cents
    expect(formatMoney(900, 'EUR', 'en')).toBe('€9.00');
    expect(formatMoney(120000, 'RUB', 'ru').replace(/\s/g, ' ')).toBe('1 200,00 ₽');
    expect(formatMoney(100, 'NOPE')).toBe('1.00 NOPE');
  });

  it('a product template names the product by token; Buy blocks and carts are found after binding', () => {
    const tpl = { root: n('root', 'section', {}, [n('b', 'buy', { productId: '{{entry.id}}', label: 'Add to cart', showPrice: true, showStock: true, align: 'left' }), n('c', 'cart', {})]) };
    expect(validatePageContent(tpl).ok).toBe(true);
    expect(collectProductIds(tpl.root)).toEqual([]); // the token is not an id
    const page = bindEntry(tpl, { id: 'cmw1e400b00frtzs8fz9vz3nu', title: 'Rye', slug: 'rye', data: {} });
    expect(collectProductIds(page.root)).toEqual(['cmw1e400b00frtzs8fz9vz3nu']);
    expect(hasCart(page.root)).toBe(true);
    expect(collectProductIds(n('r', 'section', {}, [n('x', 'buy', { productId: "x' OR 1=1" })]))).toEqual([]);
  });
});
