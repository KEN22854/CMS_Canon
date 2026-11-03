'use client';

import { create } from 'zustand';

export type ThemeChoice = 'dark' | 'light' | 'system';
const KEY = 'canon.theme';

/**
 * Runs before first paint (inlined in the root layout) so the page never flashes the wrong
 * theme. Static string: it reads only localStorage and the OS preference.
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem('${KEY}')||'dark';if(t==='system')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';d.dataset.theme=t}catch(e){d.dataset.theme='dark'}})()`;

function resolve(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function read(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'system' || v === 'dark' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

interface ThemeState {
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
}

export const useTheme = create<ThemeState>((set) => ({
  choice: typeof window === 'undefined' ? 'dark' : read(),
  setChoice: (choice) => {
    try {
      window.localStorage.setItem(KEY, choice);
    } catch {
      // Not persisted; the choice still applies to this tab.
    }
    document.documentElement.dataset.theme = resolve(choice);
    set({ choice });
  },
}));

/** Order of the user-menu toggle. */
export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { dark: 'light', light: 'system', system: 'dark' };
