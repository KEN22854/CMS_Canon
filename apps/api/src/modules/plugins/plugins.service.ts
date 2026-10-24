import { randomBytes } from 'node:crypto';
import { Prisma, type Plugin, type PluginInstance } from '@canon/db';
import { HttpStatus, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { generateApiKey } from '../../common/auth/api-key.authenticator';
import type { RequestPrincipal } from '../../common/auth/principal';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../common/http/api-error';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { assertDeliverableUrl, signWebhook } from '../webhooks/events';
import { WebhooksService } from '../webhooks/webhooks.service';
import { FIRST_PARTY_PLUGINS } from './catalog';
import { pluginManifest, publicSettings, settingsSchema, type BlockPreset, type PluginManifest, type StoredSettings } from './manifest';

type Actor = RequestPrincipal & { tenantId: string };

export const installBody = z.object({
  settings: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  /** Must equal the manifest's permissions: consent is all or nothing, never silently partial. */
  grantedPermissions: z.array(z.string()).default([]),
});
export const updateInstanceBody = z.object({
  settings: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  isActive: z.boolean().optional(),
  grantedPermissions: z.array(z.string()).optional(),
});
const MASK = '••••••••';
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Plugin lifecycle: marketplace and private catalog, install with explicit permission consent,
 * settings (secrets encrypted), a scoped API key per install, a managed webhook for the plugin's
 * events, upgrades that ask for consent again when permissions grow, and clean uninstall.
 */
@Injectable()
export class PluginsService implements OnApplicationBootstrap {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly system: SystemPrismaService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PluginsService.name);
  }

  /** Keeps first-party marketplace entries in sync with the code (fails boot on an invalid manifest). */
  async onApplicationBootstrap(): Promise<void> {
    for (const raw of FIRST_PARTY_PLUGINS) {
      const m = pluginManifest.parse(raw);
      const data = { version: m.version, description: m.description, author: m.author, manifest: m as unknown as Prisma.InputJsonValue, category: m.category, isPublic: true, isActive: true };
      await this.system.plugin.upsert({ where: { name: m.name }, create: { name: m.name, ...data }, update: data });
    }
  }

  private manifest(p: Plugin): PluginManifest {
    return p.manifest as unknown as PluginManifest;
  }

  private present(p: Plugin, inst?: PluginInstance | null) {
    const m = this.manifest(p);
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      displayName: m.displayName,
      description: m.description,
      author: m.author,
      homepage: m.homepage ?? null,
      category: m.category,
      icon: m.icon ?? null,
      permissions: m.permissions,
      events: m.events,
      settings: m.settings,
      blocks: m.blocks.map((b) => ({ key: b.key, name: b.name, description: b.description })),
      private: p.tenantId !== null,
      installation: inst
        ? {
            id: inst.id,
            isActive: inst.isActive,
            version: inst.version,
            settings: publicSettings(m, inst.settings),
            grantedPermissions: inst.grantedPermissions,
            needsConsent: !m.permissions.every((x) => inst.grantedPermissions.includes(x)),
            updateAvailable: inst.version !== p.version,
            installedAt: inst.createdAt,
          }
        : null,
    };
  }

  async catalog(tenantId: string) {
    const plugins = await this.system.plugin.findMany({ where: { isActive: true, OR: [{ tenantId: null, isPublic: true }, { tenantId }] }, orderBy: { name: 'asc' } });
    const instances = await this.system.pluginInstance.findMany({ where: { tenantId } });
    const byPlugin = new Map(instances.map((i) => [i.pluginId, i]));
    return plugins.map((p) => this.present(p, byPlugin.get(p.id)));
  }

  private async visible(tenantId: string, pluginId: string): Promise<Plugin> {
    const p = await this.system.plugin.findFirst({ where: { id: pluginId, isActive: true, OR: [{ tenantId: null, isPublic: true }, { tenantId }] } });
    if (!p) throw notFound('Plugin');
    return p;
  }

  private storeSettings(m: PluginManifest, input: Record<string, string | boolean>, previous: StoredSettings = {}): StoredSettings {
    // Secrets left masked (or empty) keep their stored value.
    const merged: Record<string, string | boolean> = {};
    const kept: Record<string, string> = {};
    for (const s of m.settings) {
      const v = input[s.key];
      if (s.kind === 'secret' && (v === undefined || v === MASK || v === '') && previous[s.key]) kept[s.key] = 'kept';
      else if (v !== undefined && v !== '') merged[s.key] = v;
    }
    const parsed = settingsSchema(m).safeParse({ ...kept, ...merged });
    if (!parsed.success) throw badRequest('INVALID_SETTINGS', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const out: StoredSettings = {};
    for (const s of m.settings) {
      if (merged[s.key] === undefined) {
        if (previous[s.key] !== undefined) out[s.key] = previous[s.key]!;
        continue;
      }
      out[s.key] = s.kind === 'secret' ? { __enc: this.webhooks.encrypt(String(merged[s.key])) } : merged[s.key]!;
    }
    return out;
  }

  async install(actor: Actor, pluginId: string, body: z.infer<typeof installBody>) {
    if (!actor.userId) throw forbidden('API keys cannot install plugins');
    const p = await this.visible(actor.tenantId, pluginId);
    const m = this.manifest(p);
    if (await this.system.pluginInstance.findUnique({ where: { pluginId_tenantId: { pluginId, tenantId: actor.tenantId } } })) throw conflict('Already installed');
    if (!sameSet(body.grantedPermissions, m.permissions)) throw new ApiError('CONSENT_REQUIRED', 'Accept exactly the permissions this plugin asks for', HttpStatus.BAD_REQUEST, { permissions: m.permissions });
    const settings = this.storeSettings(m, body.settings);
    const urlSetting = m.delivery?.kind === 'webhook' ? m.delivery.urlSetting : undefined;
    if (urlSetting) await assertDeliverableUrl(String(body.settings[urlSetting] ?? ''), this.config.NODE_ENV !== 'production');

    const key = m.permissions.length ? generateApiKey() : null;
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    const inst = await this.system.$transaction(async (tx) => {
      const apiKey = key
        ? await tx.apiKey.create({ data: { tenantId: actor.tenantId, name: `Plugin: ${m.displayName}`, keyPrefix: key.keyPrefix, keyHash: key.keyHash, scopes: m.permissions, createdById: actor.userId! } })
        : null;
      const instance = await tx.pluginInstance.create({ data: { pluginId, tenantId: actor.tenantId, settings: settings as Prisma.InputJsonValue, installedById: actor.userId, grantedPermissions: m.permissions, apiKeyId: apiKey?.id ?? null, version: p.version } });
      if (m.events.length) await tx.webhook.create({ data: { tenantId: actor.tenantId, name: `Plugin: ${m.displayName}`, url: m.delivery?.kind === 'webhook' && m.delivery.url ? m.delivery.url : `plugin://${p.name}`, events: m.events, secret: this.webhooks.encrypt(signingSecret), pluginInstanceId: instance.id } });
      return instance;
    });

    // External plugins learn their credentials from a signed install callback; otherwise the
    // installer sees the key once (e.g. to paste into Zapier).
    let showKey: string | null = key?.key ?? null;
    if (m.install && key) {
      const payload = JSON.stringify({ event: 'plugin.installed', tenantId: actor.tenantId, instanceId: inst.id, apiBaseUrl: this.config.API_PUBLIC_URL, apiKey: key.key, signingSecret });
      try {
        await assertDeliverableUrl(m.install.url, this.config.NODE_ENV !== 'production');
        const res = await fetch(m.install.url, { method: 'POST', headers: { 'content-type': 'application/json', 'canon-signature': signWebhook(payload, signingSecret) }, body: payload, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showKey = null;
      } catch (err) {
        await this.uninstallRows(actor.tenantId, inst.id);
        throw new ApiError('PLUGIN_INSTALL_FAILED', `The plugin did not accept the installation (${(err as Error).message})`, HttpStatus.BAD_GATEWAY);
      }
    }
    await this.audit.record({ tenantId: actor.tenantId, action: 'plugin.installed', entityType: 'Plugin', entityId: p.id, changes: { name: p.name, version: p.version, permissions: m.permissions, events: m.events } }, actor);
    return { ...this.present(p, inst), apiKey: showKey };
  }

  private async instance(tenantId: string, id: string) {
    const inst = await this.system.pluginInstance.findFirst({ where: { id, tenantId }, include: { plugin: true } });
    if (!inst) throw notFound('Plugin installation');
    return inst;
  }

  async update(actor: Actor, id: string, body: z.infer<typeof updateInstanceBody>) {
    const inst = await this.instance(actor.tenantId, id);
    const m = this.manifest(inst.plugin);
    const data: Prisma.PluginInstanceUpdateInput = {};
    if (body.settings) {
      const previous = inst.settings as StoredSettings;
      // A partial update keeps the other plain settings; secrets are handled by storeSettings.
      const plain = Object.fromEntries(Object.entries(previous).filter(([, v]) => typeof v !== 'object')) as Record<string, string | boolean>;
      data.settings = this.storeSettings(m, { ...plain, ...body.settings }, previous) as Prisma.InputJsonValue;
    }
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.grantedPermissions) {
      // Upgrade consent: the new manifest's permissions, all of them.
      if (!sameSet(body.grantedPermissions, m.permissions)) throw new ApiError('CONSENT_REQUIRED', 'Accept exactly the permissions this plugin asks for', HttpStatus.BAD_REQUEST, { permissions: m.permissions });
      data.grantedPermissions = m.permissions;
      data.version = inst.plugin.version;
      if (inst.apiKeyId) await this.system.apiKey.update({ where: { id: inst.apiKeyId }, data: { scopes: m.permissions } });
      await this.system.webhook.updateMany({ where: { pluginInstanceId: inst.id }, data: { events: m.events } });
    }
    const updated = await this.system.pluginInstance.update({ where: { id }, data });
    await this.audit.record({ tenantId: actor.tenantId, action: 'plugin.updated', entityType: 'Plugin', entityId: inst.pluginId, changes: { isActive: body.isActive ?? null, settings: body.settings ? Object.keys(body.settings) : null, consented: body.grantedPermissions ?? null } }, actor);
    return this.present(inst.plugin, updated);
  }

  private async uninstallRows(tenantId: string, id: string) {
    const inst = await this.system.pluginInstance.findFirst({ where: { id, tenantId } });
    if (!inst) return;
    await this.system.$transaction([
      ...(inst.apiKeyId ? [this.system.apiKey.update({ where: { id: inst.apiKeyId }, data: { revokedAt: new Date() } })] : []),
      this.system.pluginInstance.delete({ where: { id } }),
    ]);
  }

  async uninstall(actor: Actor, id: string): Promise<void> {
    const inst = await this.instance(actor.tenantId, id);
    await this.uninstallRows(actor.tenantId, id);
    await this.audit.record({ tenantId: actor.tenantId, action: 'plugin.uninstalled', entityType: 'Plugin', entityId: inst.pluginId, changes: { name: inst.plugin.name } }, actor);
  }

  /** Private plugins (Business+): the workspace's own integrations, validated like marketplace ones. */
  async registerPrivate(actor: Actor, raw: unknown) {
    const tenant = await this.system.tenant.findUniqueOrThrow({ where: { id: actor.tenantId }, select: { plan: true, slug: true } });
    if (tenant.plan === 'FREE' || tenant.plan === 'PRO') throw new ApiError('PLAN_REQUIRED', 'Private plugins are part of the Business and Enterprise plans', HttpStatus.PAYMENT_REQUIRED, { plan: 'BUSINESS' });
    const parsed = pluginManifest.safeParse(raw);
    if (!parsed.success) throw badRequest('INVALID_MANIFEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 1_000));
    const m = parsed.data;
    if (m.delivery?.kind === 'builtin') throw badRequest('INVALID_MANIFEST', 'Built-in handlers are reserved for marketplace plugins');
    if (m.delivery?.kind === 'webhook' && m.delivery.url) await assertDeliverableUrl(m.delivery.url, this.config.NODE_ENV !== 'production');
    const name = `@${tenant.slug}/${m.name}`;
    const existing = await this.system.plugin.findUnique({ where: { name } });
    if (existing && existing.tenantId !== actor.tenantId) throw conflict('Plugin name taken');
    const data = { version: m.version, description: m.description, author: m.author, manifest: m as unknown as Prisma.InputJsonValue, category: m.category, isPublic: false, isActive: true };
    const p = await this.system.plugin.upsert({ where: { name }, create: { name, tenantId: actor.tenantId, ...data }, update: data });
    await this.audit.record({ tenantId: actor.tenantId, action: existing ? 'plugin.private_updated' : 'plugin.private_registered', entityType: 'Plugin', entityId: p.id, changes: { name, version: m.version, permissions: m.permissions } }, actor);
    return this.present(p, await this.system.pluginInstance.findUnique({ where: { pluginId_tenantId: { pluginId: p.id, tenantId: actor.tenantId } } }));
  }

  /** Block presets from active installations, for the builder palette. */
  async blocks(tenantId: string): Promise<(BlockPreset & { plugin: string; pluginName: string })[]> {
    const instances = await this.system.pluginInstance.findMany({ where: { tenantId, isActive: true }, include: { plugin: true } });
    return instances.flatMap((i) => {
      const m = this.manifest(i.plugin);
      return m.blocks.map((b) => ({ ...(b as BlockPreset), plugin: m.displayName, pluginName: i.plugin.name }));
    });
  }
}
