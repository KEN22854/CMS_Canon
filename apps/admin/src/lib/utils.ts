import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { currentLocale } from './i18n';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatUsd(v: number): string {
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function formatNumber(v: number | null): string {
  return v === null
    ? currentLocale() === 'ru'
      ? 'Без лимита'
      : 'Unlimited'
    : new Intl.NumberFormat(currentLocale()).format(v);
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
  if (diff < 60) return rtf.format(-Math.round(diff), 'second');
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}
