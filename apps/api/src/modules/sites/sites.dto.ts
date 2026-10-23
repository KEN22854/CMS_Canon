import { z } from 'zod';

export const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const locale = z.string().regex(LOCALE_RE, 'Use a BCP-47 tag like "en" or "pt-BR"');
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'Enter a hostname like www.example.com');

export const SITE_TEMPLATES = ['blank', 'landing', 'blog', 'docs'] as const;

export const createSiteBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slug.optional(),
  description: z.string().max(500).optional(),
  defaultLocale: locale.default('en'),
  locales: z.array(locale).max(30).optional(),
  template: z.enum(SITE_TEMPLATES).default('landing'),
});
export type CreateSiteBody = z.infer<typeof createSiteBody>;

export const updateSiteBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().max(500).nullable(),
    domain: hostname.nullable(),
    defaultLocale: locale,
    locales: z.array(locale).min(1).max(30),
    favicon: z.string().max(40).nullable(),
    logo: z.string().max(40).nullable(),
    seoDefaults: z.object({ titleTemplate: z.string().max(120).optional(), description: z.string().max(300).optional(), ogImageMediaId: z.string().max(40).optional() }).strict(),
    settings: z.record(z.string(), z.unknown()),
  })
  .partial()
  .strict();
export type UpdateSiteBody = z.infer<typeof updateSiteBody>;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #4f46e5');

/** Design tokens the renderer maps to CSS variables; unknown keys are rejected so typos surface. */
export const themeBody = z
  .object({
    colors: z.object({ primary: color, background: color, foreground: color, muted: color }).partial().strict(),
    font: z.enum(['system', 'serif', 'mono', 'Inter', 'Manrope', 'Lora']),
    radius: z.enum(['none', 'sm', 'md', 'lg', 'full']),
    mode: z.enum(['light', 'dark', 'auto']),
  })
  .partial()
  .strict();
export type ThemeBody = z.infer<typeof themeBody>;

export const siteAiSettingsBody = z
  .object({
    brandVoice: z.string().max(2_000),
    glossary: z.array(z.object({ term: z.string().min(1).max(100), translations: z.record(z.string().regex(LOCALE_RE), z.string().max(100)).default({}), note: z.string().max(200).optional() })).max(500),
    forbiddenTopics: z.array(z.string().min(1).max(100)).max(100),
    defaultModel: z.string().max(100).nullable(),
  })
  .partial()
  .strict();
export type SiteAiSettingsBody = z.infer<typeof siteAiSettingsBody>;
