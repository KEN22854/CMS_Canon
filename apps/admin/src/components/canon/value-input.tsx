'use client';

import type { ValueType } from '@/lib/canon';
import { Input, Select } from '../ui';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'RUB', 'INR', 'CHF'];

/** Editor for a fact's typed value; the server derives the display string from it. */
export function ValueInput({ type, value, onChange, unit, onUnit }: { type: ValueType; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; unit?: string; onUnit?: (u: string) => void }) {
  const num = (k: string) => (typeof value[k] === 'number' ? String(value[k]) : '');
  const setNum = (k: string, raw: string) => onChange({ ...value, [k]: raw === '' ? undefined : Number(raw) });
  switch (type) {
    case 'MONEY':
      return (
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Amount" type="number" step="any" className="w-32" value={num('amount')} onChange={(e) => setNum('amount', e.target.value)} />
          <Select aria-label="Currency" value={String(value.currency ?? 'USD')} onChange={(e) => onChange({ ...value, currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <Select aria-label="Period" value={String(value.period ?? '')} onChange={(e) => onChange({ ...value, period: e.target.value || undefined })}>
            <option value="">one-off</option>
            <option value="month">per month</option>
            <option value="year">per year</option>
            <option value="user/month">per user / month</option>
          </Select>
        </div>
      );
    case 'NUMBER':
      return (
        <div className="flex gap-2">
          <Input aria-label="Value" type="number" step="any" className="w-32" value={num('value')} onChange={(e) => setNum('value', e.target.value)} />
          {onUnit && <Input aria-label="Unit" placeholder="unit (seats, GB…)" className="w-40" value={unit ?? ''} onChange={(e) => onUnit(e.target.value)} />}
        </div>
      );
    case 'PERCENT':
      return (
        <div className="flex items-center gap-1">
          <Input aria-label="Percent" type="number" step="any" className="w-32" value={num('value')} onChange={(e) => setNum('value', e.target.value)} /> %
        </div>
      );
    case 'DATE':
      return <Input aria-label="Date" type="date" className="w-44" value={String(value.date ?? '')} onChange={(e) => onChange({ date: e.target.value })} />;
    case 'BOOLEAN':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.value === true} onChange={(e) => onChange({ value: e.target.checked })} /> true
        </label>
      );
    case 'URL':
      return <Input aria-label="URL" type="url" value={String(value.url ?? '')} onChange={(e) => onChange({ url: e.target.value })} />;
    case 'LIST':
      return <Input aria-label="Items" placeholder="comma-separated" value={Array.isArray(value.items) ? (value.items as string[]).join(', ') : ''} onChange={(e) => onChange({ items: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />;
    default:
      return <Input aria-label="Text" value={String(value.text ?? '')} onChange={(e) => onChange({ text: e.target.value })} />;
  }
}

export function emptyValue(type: ValueType): Record<string, unknown> {
  switch (type) {
    case 'MONEY':
      return { amount: 0, currency: 'USD' };
    case 'NUMBER':
    case 'PERCENT':
      return { value: 0 };
    case 'DATE':
      return { date: new Date().toISOString().slice(0, 10) };
    case 'BOOLEAN':
      return { value: true };
    case 'URL':
      return { url: 'https://' };
    case 'LIST':
      return { items: [] };
    default:
      return { text: '' };
  }
}
