/**
 * Theme library (Stage 10). A theme is the site's design tokens — four colours, a font, corner
 * radius and colour mode — mapped by the renderer to CSS variables, so applying one restyles every
 * page and every section template at once. Presets are checked for WCAG contrast in tests.
 */
export const THEME_FONTS = ['system', 'serif', 'mono', 'Inter', 'Manrope', 'Lora'] as const;
export const THEME_RADII = ['none', 'sm', 'md', 'lg', 'full'] as const;
export const THEME_CATEGORIES = ['minimal', 'bold', 'warm', 'nature', 'dark', 'pastel', 'corporate'] as const;
export type ThemeCategory = (typeof THEME_CATEGORIES)[number];

export interface SiteThemeTokens {
  colors: { primary: string; background: string; foreground: string; muted: string };
  font: (typeof THEME_FONTS)[number];
  radius: (typeof THEME_RADII)[number];
  mode: 'light' | 'dark' | 'auto';
}

export interface ThemePreset extends SiteThemeTokens {
  key: string;
  name: string;
  nameRu: string;
  category: ThemeCategory;
}

const t = (key: string, name: string, nameRu: string, category: ThemeCategory, primary: string, background: string, foreground: string, muted: string, font: SiteThemeTokens['font'], radius: SiteThemeTokens['radius'], mode: SiteThemeTokens['mode'] = 'light'): ThemePreset => ({ key, name, nameRu, category, colors: { primary, background, foreground, muted }, font, radius, mode });

export const THEME_PRESETS: ThemePreset[] = [
  t('canon', 'Canon', 'Канон', 'minimal', '#4f46e5', '#ffffff', '#0f172a', '#f1f5f9', 'system', 'md'),
  t('paper', 'Paper', 'Бумага', 'minimal', '#111827', '#fafaf9', '#1c1917', '#f0efeb', 'serif', 'none'),
  t('mono', 'Monochrome', 'Монохром', 'minimal', '#18181b', '#ffffff', '#09090b', '#f4f4f5', 'Inter', 'sm'),
  t('nordic', 'Nordic', 'Нордик', 'minimal', '#2563eb', '#f8fafc', '#0f172a', '#e2e8f0', 'Manrope', 'lg'),
  t('electric', 'Electric', 'Электрик', 'bold', '#7c3aed', '#ffffff', '#1e1b4b', '#ede9fe', 'Manrope', 'full'),
  t('signal', 'Signal', 'Сигнал', 'bold', '#dc2626', '#ffffff', '#111827', '#fee2e2', 'Inter', 'sm'),
  t('citrus', 'Citrus', 'Цитрус', 'bold', '#c2410c', '#fffbeb', '#1c1917', '#fef3c7', 'Manrope', 'lg'),
  t('ocean', 'Ocean', 'Океан', 'bold', '#0369a1', '#f0f9ff', '#082f49', '#e0f2fe', 'Inter', 'md'),
  t('bakery', 'Bakery', 'Пекарня', 'warm', '#9a3412', '#fffaf5', '#292524', '#f5e9dc', 'Lora', 'lg'),
  t('terracotta', 'Terracotta', 'Терракота', 'warm', '#b45309', '#fdf8f3', '#3b2416', '#f3e4d4', 'serif', 'md'),
  t('coffee', 'Coffee', 'Кофейня', 'warm', '#78350f', '#faf6f1', '#1f1611', '#ede0d4', 'Lora', 'sm'),
  t('forest', 'Forest', 'Лес', 'nature', '#15803d', '#f7fdf9', '#052e16', '#dcfce7', 'Manrope', 'md'),
  t('sage', 'Sage', 'Шалфей', 'nature', '#4d7c0f', '#fbfdf7', '#1a2e05', '#ecf3df', 'Lora', 'lg'),
  t('lagoon', 'Lagoon', 'Лагуна', 'nature', '#0f766e', '#f5fdfb', '#042f2e', '#ccfbf1', 'Inter', 'full'),
  t('midnight', 'Midnight', 'Полночь', 'dark', '#818cf8', '#0b1020', '#e2e8f0', '#161d33', 'Inter', 'md', 'dark'),
  t('graphite', 'Graphite', 'Графит', 'dark', '#f4f4f5', '#18181b', '#fafafa', '#27272a', 'Manrope', 'sm', 'dark'),
  t('neon', 'Neon', 'Неон', 'dark', '#22d3ee', '#030712', '#f9fafb', '#111827', 'mono', 'none', 'dark'),
  t('velvet', 'Velvet', 'Бархат', 'dark', '#f472b6', '#1a0b16', '#fdf2f8', '#2a1424', 'Lora', 'lg', 'dark'),
  t('blossom', 'Blossom', 'Цветение', 'pastel', '#be185d', '#fff7fb', '#3f1d2e', '#fce7f3', 'Lora', 'full'),
  t('lavender', 'Lavender', 'Лаванда', 'pastel', '#6d28d9', '#faf7ff', '#2e1065', '#ede9fe', 'Manrope', 'lg'),
  t('mint', 'Mint', 'Мята', 'pastel', '#047857', '#f5fffb', '#064e3b', '#d1fae5', 'Inter', 'lg'),
  t('enterprise', 'Enterprise', 'Корпоратив', 'corporate', '#1d4ed8', '#ffffff', '#0f172a', '#eff6ff', 'Inter', 'sm'),
  t('ledger', 'Ledger', 'Финансы', 'corporate', '#0f766e', '#ffffff', '#111827', '#f0fdfa', 'system', 'none'),
  t('clinic', 'Clinic', 'Клиника', 'corporate', '#0e7490', '#f8fdff', '#0c1d26', '#e6f6fa', 'Manrope', 'md'),
];

export function getThemePreset(key: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.key === key);
}

/** Only the tokens (what PATCH /theme accepts). */
export function themeTokens(p: SiteThemeTokens): SiteThemeTokens {
  return { colors: { ...p.colors }, font: p.font, radius: p.radius, mode: p.mode };
}

// ── contrast (WCAG 2.1) ─────────────────────────────────────────────────────

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** 1 (same) … 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

export interface ThemeIssue {
  pair: 'text' | 'button' | 'link' | 'muted';
  ratio: number;
  min: number;
}

/**
 * The pairs that matter on a site: body text on the background (4.5), white button text on the
 * primary colour (4.5 — buttons are text), primary links on the background (3, large/bold), text
 * on muted bands (4.5).
 */
export function themeContrastIssues(colors: SiteThemeTokens['colors']): ThemeIssue[] {
  const checks: [ThemeIssue['pair'], string, string, number][] = [
    ['text', colors.foreground, colors.background, 4.5],
    ['button', Math.max(contrastRatio('#ffffff', colors.primary), contrastRatio('#0f172a', colors.primary)) === contrastRatio('#ffffff', colors.primary) ? '#ffffff' : '#0f172a', colors.primary, 4.5],
    ['link', colors.primary, colors.background, 3],
    ['muted', colors.foreground, colors.muted, 4.5],
  ];
  return checks.map(([pair, a, b, min]) => ({ pair, ratio: contrastRatio(a, b), min })).filter((x) => x.ratio < x.min);
}
