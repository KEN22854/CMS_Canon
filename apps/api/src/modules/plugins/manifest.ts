import { validatePageContent, type BlockNode } from '@canon/blocks';
import { z } from 'zod';
import { API_KEY_SCOPE_NAMES, type ApiKeyScope } from '../../common/auth/abilities';
import { WEBHOOK_EVENT_NAMES, type WebhookEvent } from '../webhooks/events';

export const PLUGIN_CATEGORIES = ['notifications', 'automation', 'content', 'blocks', 'analytics', 'integration'] as const;
export const BUILTIN_HANDLERS = ['slack'] as const;

const settingField = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
  label: z.string().min(1).max(80),
  kind: z.enum(['text', 'url', 'secret', 'select', 'toggle']),
  required: z.boolean().default(false),
  options: z.array(z.string().max(80)).max(30).optional(),
  help: z.string().max(300).optional(),
  placeholder: z.string().max(120).optional(),
});

const blockPreset = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
  /** A subtree of built-in blocks inserted as-is: plugins compose blocks, they never ship code to sites. */
  tree: z.unknown(),
});

/**
 * What a plugin is allowed to be. Plugins are integrations, not code running inside Canon: they
 * receive signed events (webhooks or a built-in adapter), act through a scoped API key the tenant
 * consented to, and contribute block presets made of built-in blocks. Nothing here executes
 * third-party code in the API or on customer sites.
 */
export const pluginManifest = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/, 'lower-case letters, digits and dashes'),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'semver'),
    displayName: z.string().min(2).max(60),
    description: z.string().max(400),
    author: z.string().max(80),
    homepage: z.url().optional(),
    category: z.enum(PLUGIN_CATEGORIES),
    icon: z.string().max(8).optional(),
    permissions: z.array(z.enum(API_KEY_SCOPE_NAMES as [ApiKeyScope, ...ApiKeyScope[]])).max(10).default([]),
    events: z.array(z.enum(WEBHOOK_EVENT_NAMES as [WebhookEvent, ...WebhookEvent[]])).max(20).default([]),
    settings: z.array(settingField).max(20).default([]),
    delivery: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('webhook'), url: z.url().optional(), urlSetting: z.string().optional() }),
        z.object({ kind: z.literal('builtin'), handler: z.enum(BUILTIN_HANDLERS) }),
      ])
      .optional(),
    blocks: z.array(blockPreset).max(30).default([]),
    /** Called once on install with the scoped API key (signed like any delivery). */
    install: z.object({ url: z.url() }).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.events.length && !m.delivery) ctx.addIssue({ code: 'custom', path: ['delivery'], message: 'Plugins that subscribe to events need a delivery' });
    if (m.delivery?.kind === 'webhook' && !m.delivery.url === !m.delivery.urlSetting) ctx.addIssue({ code: 'custom', path: ['delivery'], message: 'Set exactly one of url or urlSetting' });
    const urlSetting = m.delivery?.kind === 'webhook' ? m.delivery.urlSetting : undefined;
    if (urlSetting && !m.settings.some((s) => s.key === urlSetting && s.kind === 'url')) ctx.addIssue({ code: 'custom', path: ['delivery', 'urlSetting'], message: 'urlSetting must name a url setting' });
    if (m.install && !m.permissions.length) ctx.addIssue({ code: 'custom', path: ['install'], message: 'An install callback only makes sense with permissions' });
    const keys = new Set<string>();
    for (const s of m.settings) {
      if (keys.has(s.key)) ctx.addIssue({ code: 'custom', path: ['settings'], message: `Duplicate setting "${s.key}"` });
      keys.add(s.key);
      if (s.kind === 'select' && !s.options?.length) ctx.addIssue({ code: 'custom', path: ['settings'], message: `Select "${s.key}" needs options` });
    }
    m.blocks.forEach((b, i) => {
      const res = validatePageContent({ root: { id: 'root', type: 'section', props: {}, children: [b.tree] } });
      if (!res.ok) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'tree'], message: res.issues.map((x) => `${x.path}: ${x.message}`).join('; ').slice(0, 300) });
    });
  });
export type PluginManifest = z.infer<typeof pluginManifest>;
export type BlockPreset = { key: string; name: string; description: string; tree: BlockNode };

/** Instance settings: secrets are stored encrypted as { __enc } and never returned to the browser. */
export type StoredSettings = Record<string, string | boolean | { __enc: string }>;

export function settingsSchema(m: PluginManifest) {
  return z
    .object(
      Object.fromEntries(
        m.settings.map((s) => {
          let f: z.ZodType;
          if (s.kind === 'toggle') f = z.boolean();
          else if (s.kind === 'url') f = z.url().max(2_000);
          else if (s.kind === 'select') f = z.enum(s.options as [string, ...string[]]);
          else f = z.string().max(2_000);
          return [s.key, s.required ? f : f.optional()];
        }),
      ),
    )
    .strict();
}

export function readSettings(m: PluginManifest, stored: unknown, decrypt: (s: string) => string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries((stored ?? {}) as StoredSettings)) {
    if (!m.settings.some((s) => s.key === k)) continue;
    out[k] = typeof v === 'object' && v && '__enc' in v ? decrypt(v.__enc) : (v as string | boolean);
  }
  return out;
}

/** Settings as the admin sees them: secrets masked. */
export function publicSettings(m: PluginManifest, stored: unknown): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries((stored ?? {}) as StoredSettings)) {
    const def = m.settings.find((s) => s.key === k);
    if (!def) continue;
    out[k] = def.kind === 'secret' ? '••••••••' : (v as string | boolean);
  }
  return out;
}
