'use client';

import { formatMoney } from '@canon/blocks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The shop on a published site. The cart is a list of product ids and quantities kept in the
 * visitor's browser (per site); titles and prices in it are only for display — the server
 * recomputes every amount from published products when the order is placed. Buy blocks are plain
 * markup (price, stock, a button) rendered on the server; this script gives the buttons and the
 * Cart block their behaviour.
 */

interface Line {
  id: string;
  title: string;
  price: number;
  currency: string;
  quantity: number;
}

interface CartConfig {
  currency: string;
  paymentMethods: string[];
  locale: string;
  title: string;
  emptyText: string;
  checkoutLabel: string;
  successText: string;
  askAddress: boolean;
}

interface Placed {
  number: number;
  total: number;
  currency: string;
  items: { title: string; quantity: number; lineTotal: number }[];
}

const KEY = 'canon.cart';
const EVENT = 'canon-cart';

const T = {
  en: { added: 'Added to cart', openCart: 'Open cart', remove: 'Remove', quantity: 'Quantity of {title}', total: 'Total', name: 'Name', email: 'Email', phone: 'Phone', address: 'Delivery address', note: 'Note for the shop', payment: 'Payment', cash: 'Cash on delivery', card_on_delivery: 'Card on delivery', transfer: 'Bank transfer', order: 'Order #{number}', sending: 'Placing the order…', OUT_OF_STOCK: 'Not enough in stock: {message}', PRODUCT_UNAVAILABLE: 'Some products are no longer available — remove them and try again.', RATE_LIMITED: 'Too many orders — try again in a few minutes.', error: 'The order could not be placed. Try again.', offline: 'Payment is made offline: the shop will contact you.' },
  ru: { added: 'Добавлено в корзину', openCart: 'Открыть корзину', remove: 'Убрать', quantity: 'Количество: {title}', total: 'Итого', name: 'Имя', email: 'Эл. почта', phone: 'Телефон', address: 'Адрес доставки', note: 'Комментарий для магазина', payment: 'Оплата', cash: 'Наличными при получении', card_on_delivery: 'Картой при получении', transfer: 'Банковский перевод', order: 'Заказ №{number}', sending: 'Оформляем заказ…', OUT_OF_STOCK: 'Не хватает на складе: {message}', PRODUCT_UNAVAILABLE: 'Некоторых товаров больше нет — уберите их и попробуйте снова.', RATE_LIMITED: 'Слишком много заказов — попробуйте через несколько минут.', error: 'Не получилось оформить заказ. Попробуйте ещё раз.', offline: 'Оплата не через сайт: магазин свяжется с вами.' },
} as const;
type Msg = keyof (typeof T)['en'];
const tr = (locale: string, k: Msg, vars: Record<string, string | number> = {}) => (T[locale.startsWith('ru') ? 'ru' : 'en'][k] as string).replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v] ?? ''));

function read(): Line[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? (raw as Line[]).filter((l) => typeof l.id === 'string' && Number.isInteger(l.quantity) && l.quantity > 0).slice(0, 30) : [];
  } catch {
    return [];
  }
}

function write(lines: Line[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Private mode or full storage: the cart lives for this page only.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function Shop({ locale }: { locale: string }) {
  const [toast, setToast] = useState<string | null>(null);
  const [carts, setCarts] = useState<{ el: HTMLElement; config: CartConfig }[]>([]);

  useEffect(() => {
    // Buy buttons: one listener for the page.
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-canon-add]');
      const box = btn?.closest<HTMLElement>('[data-canon-buy]');
      if (!btn || !box || btn.disabled) return;
      const line: Line = { id: box.dataset.canonBuy!, title: box.dataset.title ?? '', price: Number(box.dataset.price) || 0, currency: box.dataset.currency ?? 'USD', quantity: 1 };
      const lines = read();
      const at = lines.findIndex((l) => l.id === line.id);
      if (at >= 0) lines[at] = { ...line, quantity: Math.min(99, lines[at]!.quantity + 1) };
      else lines.push(line);
      write(lines);
      setToast(line.title);
    };
    document.addEventListener('click', onClick);
    setCarts(
      [...document.querySelectorAll<HTMLElement>('[data-canon-cart]')].flatMap((el) => {
        try {
          el.querySelector('[data-canon-cart-fallback]')?.setAttribute('hidden', '');
          return [{ el: el.querySelector<HTMLElement>('[data-canon-cart-root]') ?? el, config: JSON.parse(el.dataset.canonCart ?? '{}') as CartConfig }];
        } catch {
          return [];
        }
      }),
    );
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <>
      {carts.map((c, i) => createPortal(<Cart config={c.config} />, c.el, `cart${i}`))}
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-site bg-site-fg px-4 py-3 text-sm text-site-bg shadow-lg">
          <span>
            {tr(locale, 'added')}: <strong>{toast}</strong>
          </span>
          {carts.length === 0 && (
            <a href="/cart" className="font-semibold underline">
              {tr(locale, 'openCart')}
            </a>
          )}
        </div>
      )}
    </>
  );
}

function useCart(): [Line[], (lines: Line[]) => void] {
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => {
    const sync = () => setLines(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => (window.removeEventListener(EVENT, sync), window.removeEventListener('storage', sync));
  }, []);
  return [lines, useCallback((next: Line[]) => write(next), [])];
}

function Cart({ config }: { config: CartConfig }) {
  const [lines, setLines] = useCart();
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const started = useMemo(() => performance.now(), []);
  const L = (k: Msg, v?: Record<string, string | number>) => tr(config.locale, k, v);
  const money = (n: number) => formatMoney(n, config.currency, config.locale);
  const shown = lines.filter((l) => l.currency === config.currency);
  const total = shown.reduce((s, l) => s + l.price * l.quantity, 0);

  if (placed)
    return (
      <div className="space-y-3 rounded-site border border-site-fg/10 p-6" role="status">
        <p className="text-xl font-semibold">{L('order', { number: placed.number })}</p>
        <p>{config.successText}</p>
        <ul className="text-sm opacity-80">
          {placed.items.map((i) => (
            <li key={i.title}>
              {i.quantity} × {i.title} — {money(i.lineTotal)}
            </li>
          ))}
        </ul>
        <p className="font-semibold">
          {L('total')}: {formatMoney(placed.total, placed.currency, config.locale)}
        </p>
      </div>
    );
  if (!shown.length) return <p className="opacity-70">{config.emptyText}</p>;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim() || undefined;
    setSending(true);
    setError(null);
    const res = await fetch('/api/shop/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: shown.map((l) => ({ productId: l.id, quantity: l.quantity })),
        customer: { name: get('name'), email: get('email'), phone: get('phone'), address: get('address'), note: get('note') },
        paymentMethod: get('payment'),
        locale: config.locale,
        honeypot: get('website'),
        elapsedMs: Math.round(performance.now() - started),
      }),
    }).catch(() => null);
    setSending(false);
    const out = (await res?.json().catch(() => null)) as (Placed & { ok?: boolean; code?: string; message?: string }) | null;
    if (res?.ok && out) {
      setPlaced(out);
      setLines(lines.filter((l) => l.currency !== config.currency));
      return;
    }
    const code = out?.code as Msg | undefined;
    setError(code && code in T.en ? L(code, { message: out?.message ?? '' }) : L('error'));
  };

  const input = 'w-full rounded-site border border-site-fg/20 bg-site-bg px-3 py-2';
  return (
    <div className="space-y-6">
      <ul className="divide-y divide-site-fg/10 rounded-site border border-site-fg/10">
        {shown.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="min-w-0 flex-1 font-medium">{l.title}</span>
            <input
              type="number"
              min={1}
              max={99}
              value={l.quantity}
              aria-label={L('quantity', { title: l.title })}
              onChange={(e) => setLines(lines.map((x) => (x.id === l.id ? { ...x, quantity: Math.max(1, Math.min(99, Number(e.target.value) || 1)) } : x)))}
              className="w-20 rounded-site border border-site-fg/20 bg-site-bg px-2 py-1"
            />
            <span className="w-28 text-right tabular-nums">{money(l.price * l.quantity)}</span>
            <button type="button" onClick={() => setLines(lines.filter((x) => x.id !== l.id))} className="text-sm underline opacity-70 hover:opacity-100">
              {L('remove')}
            </button>
          </li>
        ))}
        <li className="flex justify-between p-4 font-semibold">
          <span>{L('total')}</span>
          <span className="tabular-nums">{money(total)}</span>
        </li>
      </ul>

      <form onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{L('name')}</span>
          <input name="name" required maxLength={120} autoComplete="name" className={input} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{L('email')}</span>
          <input name="email" type="email" required maxLength={254} autoComplete="email" className={input} />
        </label>
        <label className="space-y-1 text-sm">
          <span>{L('phone')}</span>
          <input name="phone" type="tel" maxLength={40} autoComplete="tel" className={input} />
        </label>
        {config.askAddress && (
          <label className="space-y-1 text-sm sm:col-span-2">
            <span>{L('address')}</span>
            <textarea name="address" rows={2} maxLength={500} autoComplete="street-address" className={input} />
          </label>
        )}
        <label className="space-y-1 text-sm sm:col-span-2">
          <span>{L('note')}</span>
          <textarea name="note" rows={2} maxLength={1000} className={input} />
        </label>
        <fieldset className="space-y-2 text-sm sm:col-span-2">
          <legend className="mb-1">{L('payment')}</legend>
          {config.paymentMethods.map((m, i) => (
            <label key={m} className="flex items-center gap-2">
              <input type="radio" name="payment" value={m} defaultChecked={i === 0} required /> {L(m as Msg)}
            </label>
          ))}
          <p className="text-xs opacity-60">{L('offline')}</p>
        </fieldset>
        {/* Left empty by people, filled by bots. */}
        <input name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
        {error && (
          <p role="alert" className="text-sm text-red-600 sm:col-span-2">
            {error}
          </p>
        )}
        <button type="submit" disabled={sending} className="rounded-site bg-site-primary px-6 py-3 font-semibold text-white shadow hover:opacity-90 disabled:opacity-60 sm:col-span-2">
          {sending ? L('sending') : `${config.checkoutLabel} · ${money(total)}`}
        </button>
      </form>
    </div>
  );
}
