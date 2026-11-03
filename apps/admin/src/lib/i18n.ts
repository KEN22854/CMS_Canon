'use client';

import { useCallback } from 'react';
import { create } from 'zustand';
import { en, type MessageKey } from './messages/en';
import { ru } from './messages/ru';

export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_LABEL: Record<Locale, string> = { en: 'English', ru: 'Русский' };

const DICTS: Record<Locale, Record<MessageKey, string>> = { en, ru };
const STORAGE_KEY = 'canon.locale';

const isLocale = (v: unknown): v is Locale =>
  typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage blocked: fall through to the browser language.
  }
  return navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

interface LocaleState {
  locale: Locale;
  /** True once the person picked a language here (it then wins over the profile). */
  explicit: boolean;
  setLocale: (l: Locale, explicit?: boolean) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initialLocale(),
  explicit: false,
  setLocale: (locale, explicit = true) => {
    set({ locale, explicit });
    current = locale;
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    if (explicit) {
      try {
        window.localStorage.setItem(STORAGE_KEY, locale);
      } catch {
        // Not persisted locally; the profile still keeps it.
      }
    }
  },
}));

/** Module-level mirror for non-React helpers (relativeTime, number formatting). */
let current: Locale = useLocaleStore.getState().locale;
export const currentLocale = (): Locale => current;

/** Adopts the profile language on sign-in unless this browser already chose one. */
export function adoptProfileLocale(profile: string | undefined): void {
  const s = useLocaleStore.getState();
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (!saved && !s.explicit && isLocale(profile) && profile !== s.locale) s.setLocale(profile, false);
}

type Vars = Record<string, string | number>;

function format(template: string, vars?: Vars): string {
  return vars
    ? template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
    : template;
}

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  // Keys built at runtime (e.g. notification types) may be unknown: '' lets callers fall back.
  const msg: string = DICTS[locale][key] ?? en[key] ?? '';
  // Plural messages hold forms separated by "|": en "one|other", ru "one|few|many|other".
  if (msg.includes('|') && vars && typeof vars.count === 'number') {
    const forms = msg.split('|');
    const order = locale === 'ru' ? ['one', 'few', 'many', 'other'] : ['one', 'other'];
    const cat = new Intl.PluralRules(locale).select(vars.count);
    return format(forms[Math.max(0, order.indexOf(cat))] ?? forms.at(-1)!, vars);
  }
  return format(msg, vars);
}

/** `const t = useT(); t('nav.sites')`, `t('forms.fields', { count: 3 })`. */
export function useT() {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback((key: MessageKey, vars?: Vars) => translate(locale, key, vars), [locale]);
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

export type { MessageKey };
