'use client';

import { newId } from '@canon/blocks';
import { PAYMENT_METHODS, type CollectionCommerce, type PaymentMethod } from '@canon/fields';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Input, Label, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import type { Collection } from '@/lib/collections';
import { useT, type MessageKey } from '@/lib/i18n';
import { useTenantId } from '@/lib/queries';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'RUB', 'KZT', 'UAH', 'BYN', 'TRY', 'PLN', 'CHF'];

/** A collection as a shop: price, stock and SKU fields, currency, offline payment methods, order email. */
export function ShopCard({ siteId, collection, canEdit }: { siteId: string; collection: Collection; canEdit: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const tid = useTenantId();
  const shop = collection.settings.commerce;
  const numbers = collection.fields.filter((f) => f.type === 'number' && !f.multiple);
  const texts = collection.fields.filter((f) => f.type === 'text');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CollectionCommerce>(shop ?? { priceField: numbers[0]?.name ?? '', stockField: numbers.find((f) => /stock|qty|quantity|остат/i.test(f.name))?.name, skuField: texts.find((f) => /sku|article|артикул/i.test(f.name))?.name, currency: 'USD', paymentMethods: ['cash', 'transfer'] });
  const label = (name?: string) => collection.fields.find((f) => f.name === name)?.label ?? name ?? '';

  const save = useMutation({
    mutationFn: (next: CollectionCommerce | undefined) => {
      const { commerce: _old, ...rest } = collection.settings;
      return api<Collection>(`/sites/${siteId}/collections/${collection.id}`, { method: 'PATCH', body: { settings: next ? { ...rest, commerce: next } : rest } });
    },
    onSuccess: () => {
      toast.success(t('shop.saved'));
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['collection', tid, collection.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // A /cart page with the Cart block, published: the toast after "Add to cart" links there.
  const cartPage = useMutation({
    mutationFn: async () => {
      const page = await api<{ id: string; version: number }>(`/sites/${siteId}/pages`, { body: { title: t('shop.cartPageTitle'), slug: 'cart' } });
      await api(`/sites/${siteId}/pages/${page.id}`, { method: 'PATCH', body: { expectedVersion: page.version, content: { root: { id: newId(), type: 'section', props: {}, children: [{ id: newId(), type: 'section', props: { background: 'default', paddingY: 'lg', width: 'narrow' }, children: [{ id: newId(), type: 'cart', props: { title: t('shop.cartPageTitle'), emptyText: t('shop.cartEmpty'), checkoutLabel: t('shop.cartOrder'), successText: t('shop.cartThanks'), askAddress: true }, children: [] }] }] } } } });
      await api(`/sites/${siteId}/pages/${page.id}/publish`, { body: {} });
    },
    onSuccess: () => toast.success(t('shop.cartCreated')),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (patch: Partial<CollectionCommerce>) => setDraft((d) => ({ ...d, ...patch }));
  const toggleMethod = (m: PaymentMethod) => set({ paymentMethods: draft.paymentMethods.includes(m) ? draft.paymentMethods.filter((x) => x !== m) : [...draft.paymentMethods, m] });
  const valid = Boolean(draft.priceField) && draft.paymentMethods.length > 0 && /^[A-Z]{3}$/.test(draft.currency) && (!draft.orderEmail || /.+@.+\..+/.test(draft.orderEmail));

  return (
    <section aria-labelledby="shop-title" className="mb-4 rounded-md border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="shop-title" className="flex items-center gap-2 text-sm font-semibold">
            <ShoppingBag className="h-4 w-4 text-primary" /> {t('shop.title')}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{shop ? t('shop.on', { currency: shop.currency, price: label(shop.priceField), stock: shop.stockField ? t('shop.onStock', { stock: label(shop.stockField) }) : '' }) : t('shop.off')}</p>
          {shop && <p className="mt-1 text-xs text-muted-foreground">{t('shop.hint')}</p>}
        </div>
        {!editing && (
          <div className="flex gap-2">
            {shop && canEdit && (
              <Button size="sm" variant="outline" loading={cartPage.isPending} onClick={() => cartPage.mutate()}>
                {t('shop.createCart')}
              </Button>
            )}
            {shop && (
              <Link href={`/sites/${siteId}/orders`}>
                <Button size="sm" variant="outline">
                  {t('shop.openOrders')}
                </Button>
              </Link>
            )}
            {canEdit && (
              <Button size="sm" variant={shop ? 'outline' : 'default'} onClick={() => setEditing(true)}>
                {shop ? t('shop.edit') : t('shop.enable')}
              </Button>
            )}
          </div>
        )}
      </div>

      {editing &&
        (numbers.length === 0 ? (
          <p className="mt-3 text-sm text-warning">{t('shop.noNumber')}</p>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <FieldSelect id="shop-price" label={t('shop.priceField')} value={draft.priceField} options={numbers} onChange={(v) => set({ priceField: v ?? '' })} required t={t} />
              <FieldSelect id="shop-stock" label={t('shop.stockField')} value={draft.stockField} options={numbers.filter((f) => f.name !== draft.priceField)} onChange={(v) => set({ stockField: v })} t={t} />
              <FieldSelect id="shop-sku" label={t('shop.skuField')} value={draft.skuField} options={texts} onChange={(v) => set({ skuField: v })} t={t} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="shop-currency">{t('shop.currency')}</Label>
                <Select id="shop-currency" className="w-full" value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="shop-email">{t('shop.orderEmail')}</Label>
                <Input id="shop-email" type="email" value={draft.orderEmail ?? ''} onChange={(e) => set({ orderEmail: e.target.value.trim() || undefined })} />
              </div>
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">{t('shop.methods')}</legend>
              <div className="flex flex-wrap gap-4">
                {PAYMENT_METHODS.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={draft.paymentMethods.includes(m)} onChange={() => toggleMethod(m)} /> {t(`shop.method.${m}` as MessageKey)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!valid} loading={save.isPending} onClick={() => save.mutate(draft)}>
                {t('shop.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('shop.cancel')}
              </Button>
              {shop && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => save.mutate(undefined)}>
                  {t('shop.turnOff')}
                </Button>
              )}
            </div>
          </div>
        ))}
    </section>
  );
}

function FieldSelect({ id, label, value, options, onChange, required, t }: { id: string; label: string; value?: string; options: { name: string; label: string }[]; onChange: (v: string | undefined) => void; required?: boolean; t: ReturnType<typeof useT> }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} className="w-full" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{required ? t('shop.choose') : t('shop.none')}</option>
        {options.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
