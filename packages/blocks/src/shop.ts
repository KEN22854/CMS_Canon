import type { BlockNode } from './tree';

/**
 * Shop (Stage 7). Products are entries of a collection with commerce settings; delivery resolves
 * what the "Buy" blocks need (title, price, stock) from published snapshots, and checkout recomputes
 * every amount on the server — the browser's cart is only a list of ids and quantities.
 */

/** Amounts travel in minor units (cents). Collections store prices in the major unit (12.5). */
export const toMinor = (major: number): number => Math.round(major * 100);

/** "€12.50", "1 200,00 ₽" — the visitor's locale, the shop's currency. */
export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** What a Buy block shows: resolved by delivery, never taken from the page or the browser. */
export interface ShopProduct {
  id: string;
  title: string;
  slug: string;
  price: number;
  currency: string;
  /** null = not tracked (always available). */
  stock: number | null;
  available: boolean;
}

/** The shop's public configuration for a page with a Cart block. */
export interface ShopConfig {
  collectionId: string;
  currency: string;
  paymentMethods: string[];
}

export const MAX_ORDER_LINES = 30;
export const MAX_LINE_QUANTITY = 99;

/** Product ids named by Buy blocks (after entry tokens are filled). */
export function collectProductIds(root: BlockNode): string[] {
  const out = new Set<string>();
  const walk = (n: BlockNode) => {
    if (n.type === 'buy' && typeof n.props.productId === 'string' && /^[a-z0-9]{8,40}$/i.test(n.props.productId)) out.add(n.props.productId);
    n.children.forEach(walk);
  };
  walk(root);
  return [...out].slice(0, 50);
}

export function hasCart(root: BlockNode): boolean {
  return root.type === 'cart' || root.children.some(hasCart);
}
