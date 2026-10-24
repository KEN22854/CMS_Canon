import type { Plugin, PluginInstance } from '@canon/db';
import { readSettings, type PluginManifest } from '../plugins/manifest';
import type { Envelope } from './webhooks.service';

export interface Target {
  url: string;
  body: string;
  headers: Record<string, string>;
}

type Data = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Human sentence for chat notifications; unknown events fall back to their name. */
function describe(e: Envelope): string {
  const d = (e.data ?? {}) as Data;
  switch (e.type) {
    case 'page.published':
      return `📄 Page published: ${str(d.fullPath)} (${str(d.locale)})`;
    case 'page.unpublished':
      return `🙈 Page unpublished: ${str(d.fullPath)} (${str(d.locale)})`;
    case 'page.moved':
      return `↪️ Page moved: ${str(d.fromPath)} → ${str(d.toPath)}`;
    case 'entry.published':
      return `🗂 Entry published: ${str(d.slug)} (${str(d.locale)})`;
    case 'fact.changed':
      return `🧭 Canon fact changed: ${str(d.key)} (v${String(d.version ?? '')}) — affected pages will be updated`;
    case 'ping':
      return '👋 Canon is connected to this channel';
    default:
      return `Canon event: ${e.type}`;
  }
}

const BUILTIN: Record<string, (s: Record<string, string | boolean>, e: Envelope) => Target | null> = {
  slack: (s, e) => {
    const url = str(s.webhookUrl);
    if (!url) return null;
    const text = describe(e);
    return { url, body: JSON.stringify({ text, ...(s.channel ? { channel: s.channel } : {}) }), headers: {} };
  },
};

/** Where and what to send for a plugin's subscription; null = nothing to send for this event. */
export function pluginTarget(instance: PluginInstance & { plugin: Plugin }, envelope: Envelope, decrypt: (s: string) => string): Target | null {
  const m = instance.plugin.manifest as unknown as PluginManifest;
  const settings = readSettings(m, instance.settings, decrypt);
  if (m.delivery?.kind === 'builtin') return BUILTIN[m.delivery.handler]?.(settings, envelope) ?? null;
  if (m.delivery?.kind === 'webhook') {
    const url = m.delivery.url ?? str(settings[m.delivery.urlSetting ?? '']);
    if (!url) return null;
    return { url, body: JSON.stringify({ ...envelope, plugin: { name: instance.plugin.name, instanceId: instance.id } }), headers: { 'canon-plugin': instance.plugin.name } };
  }
  return null;
}
