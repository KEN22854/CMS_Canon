import { formatMoney } from '@canon/blocks';
import type { Prisma } from '@canon/db';
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Post, Put, type OnApplicationBootstrap } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/decorators';
import { TenantScope, type TenantPrincipal } from '../../common/auth/principal';
import { FieldEncryption } from '../../common/crypto/encryption';
import { badRequest, notFound } from '../../common/http/api-error';
import { ZodBody } from '../../common/http/zod-body.pipe';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesModule } from '../sites/sites.module';
import { SitesService } from '../sites/sites.service';

export const TELEGRAM_EVENTS = ['order.placed', 'form.submitted'] as const;
const TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/;

const connectBody = z.object({
  /** Omit to keep the saved token (changing only the chat or the events). */
  botToken: z.string().trim().regex(TOKEN_RE, 'A token from @BotFather looks like 123456:ABC…').optional(),
  /** A numeric chat/channel id (-100…) or a public @channel. */
  chatId: z.string().trim().regex(/^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/, 'A chat id like -1001234567890 or @channel'),
  events: z.array(z.enum(TELEGRAM_EVENTS)).max(TELEGRAM_EVENTS.length).default(['order.placed', 'form.submitted']),
});
type ConnectBody = z.infer<typeof connectBody>;

interface Stored {
  token: string; // encrypted
  tokenHint: string;
  chatId: string;
  events: string[];
  botName?: string;
}

/**
 * Telegram (Stage 18, local integrations): a site's bot posts new orders and form submissions to a
 * chat, and automations can send a message. The bot token is encrypted at rest (AES-256-GCM, the
 * same key as webhook secrets) and never returned; messages are plain text (no parse mode), so
 * customer input can't turn into markup or links that look like the shop's.
 */
@Injectable()
export class TelegramService implements OnApplicationBootstrap {
  private readonly crypto: FieldEncryption;

  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.crypto = new FieldEncryption(config.ENCRYPTION_KEY);
    this.logger.setContext(TelegramService.name);
  }

  onApplicationBootstrap(): void {
    this.bus.on('OrderPlaced', (e) => this.onOrder(e));
    this.bus.on('FormSubmitted', (e) => this.onForm(e));
  }

  async status(tenantId: string, siteId: string) {
    const site = await this.sites.get(tenantId, siteId);
    const s = read(site.settings);
    return s ? { connected: true, chatId: s.chatId, events: s.events, tokenHint: s.tokenHint, botName: s.botName ?? null } : { connected: false };
  }

  async connect(actor: TenantPrincipal, siteId: string, body: ConnectBody) {
    const site = await this.sites.get(actor.tenantId, siteId);
    const prev = read(site.settings);
    const token = body.botToken ?? (prev ? this.crypto.decrypt(prev.token) : null);
    if (!token) throw badRequest('TOKEN_REQUIRED', 'Paste the bot token from @BotFather');
    const me = await this.call<{ username?: string }>(token, 'getMe', {});
    if (!me.ok) throw badRequest('TELEGRAM_TOKEN', 'Telegram did not accept this token');
    const stored: Stored = { token: this.crypto.encrypt(token), tokenHint: `…${token.slice(-4)}`, chatId: body.chatId, events: body.events, botName: me.result?.username };
    await this.save(actor, siteId, site.settings, stored);
    await this.audit.record({ tenantId: actor.tenantId, action: 'integration.telegram_connected', entityType: 'Site', entityId: siteId, changes: { chatId: body.chatId, events: body.events } }, actor);
    return this.status(actor.tenantId, siteId);
  }

  async test(actor: TenantPrincipal, siteId: string) {
    const site = await this.sites.get(actor.tenantId, siteId);
    const s = read(site.settings);
    if (!s) throw notFound('Telegram connection');
    const res = await this.send(s, `✅ ${site.name}: Canon is connected. New orders and requests will appear here.`);
    if (!res.ok) throw badRequest('TELEGRAM_SEND', res.description ?? 'Telegram refused the message — is the bot a member of the chat?');
    return { sent: true };
  }

  async disconnect(actor: TenantPrincipal, siteId: string): Promise<void> {
    const site = await this.sites.get(actor.tenantId, siteId);
    const { telegram: _t, ...rest } = (site.settings ?? {}) as Record<string, unknown>;
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data: { settings: rest as Prisma.InputJsonValue } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'integration.telegram_disconnected', entityType: 'Site', entityId: siteId }, actor);
  }

  /** For automations: a plain message to the site's chat. false when Telegram isn't connected. */
  async notify(siteId: string, text: string): Promise<boolean> {
    const site = await this.system.site.findFirst({ where: { id: siteId }, select: { settings: true } });
    const s = read(site?.settings);
    if (!s) return false;
    const res = await this.send(s, text);
    if (!res.ok) throw new Error(`telegram: ${res.description ?? 'refused'}`);
    return true;
  }

  private async onOrder(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; orderId: string };
    const site = await this.system.site.findFirst({ where: { id: p.siteId }, select: { name: true, settings: true } });
    const s = read(site?.settings);
    if (!s?.events.includes('order.placed')) return;
    const o = await this.system.order.findFirst({ where: { id: p.orderId } });
    if (!o) return;
    const c = o.customer as { name: string; email: string; phone?: string; address?: string };
    const lines = (o.items as { title: string; quantity: number; lineTotal: number }[]).map((i) => `• ${i.quantity} × ${i.title} — ${formatMoney(i.lineTotal, o.currency, o.locale)}`);
    const text = [`🛒 ${site!.name}: order #${o.number}`, ...lines, `Total: ${formatMoney(o.total, o.currency, o.locale)}`, `${c.name} · ${c.email}${c.phone ? ` · ${c.phone}` : ''}`, ...(c.address ? [c.address] : []), `${this.config.ADMIN_PUBLIC_URL}/sites/${p.siteId}/orders?order=${o.id}`].join('\n');
    const res = await this.send(s, text);
    // Telegram down → the outbox retries; a refused message (bot removed) is logged, not retried forever.
    if (!res.ok && res.status !== undefined && res.status >= 500) throw new Error('telegram unavailable');
    if (!res.ok) this.logger.warn({ siteId: p.siteId, description: res.description }, 'telegram.order_not_sent');
  }

  private async onForm(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; formName: string; data: Record<string, unknown> };
    const site = await this.system.site.findFirst({ where: { id: p.siteId }, select: { name: true, settings: true } });
    const s = read(site?.settings);
    if (!s?.events.includes('form.submitted')) return;
    const fields = Object.entries(p.data).filter(([, v]) => v !== '' && v !== null && v !== undefined).slice(0, 15).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`.slice(0, 300));
    const res = await this.send(s, [`📨 ${site!.name}: “${p.formName}”`, ...fields].join('\n'));
    if (!res.ok && res.status !== undefined && res.status >= 500) throw new Error('telegram unavailable');
    if (!res.ok) this.logger.warn({ siteId: p.siteId, description: res.description }, 'telegram.form_not_sent');
  }

  private send(s: Stored, text: string) {
    return this.call(this.crypto.decrypt(s.token), 'sendMessage', { chat_id: s.chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
  }

  private async call<T>(token: string, method: string, body: object): Promise<{ ok: boolean; result?: T; description?: string; status?: number }> {
    try {
      const res = await fetch(`${this.config.TELEGRAM_API_URL}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
      return { ok: Boolean(out.ok), result: out.result, description: out.description, status: res.status };
    } catch {
      return { ok: false, description: 'Telegram is unreachable', status: 503 };
    }
  }

  private async save(actor: TenantPrincipal, siteId: string, settings: unknown, telegram: Stored): Promise<void> {
    await this.prisma.forTenant({ tenantId: actor.tenantId, userId: actor.userId }).site.update({ where: { id: siteId }, data: { settings: { ...((settings as object) ?? {}), telegram } as unknown as Prisma.InputJsonValue } });
  }
}

function read(settings: unknown): Stored | null {
  const t = (settings as { telegram?: Stored } | null)?.telegram;
  return t && typeof t.token === 'string' && typeof t.chatId === 'string' ? { ...t, events: Array.isArray(t.events) ? t.events : [] } : null;
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller({ path: 'sites/:siteId/integrations/telegram', version: '1' })
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get()
  @RequirePermission('read', 'Site')
  status(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.telegram.status(p.tenantId, siteId);
  }

  @Put()
  @RequirePermission('update', 'Site')
  @ApiOperation({ summary: 'Connect a Telegram bot (token checked with getMe, stored encrypted) and the chat to post orders and form submissions to' })
  connect(@Param('siteId') siteId: string, @Body(new ZodBody(connectBody)) body: ConnectBody, @TenantScope() p: TenantPrincipal) {
    return this.telegram.connect(p, siteId, body);
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermission('update', 'Site')
  test(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal) {
    return this.telegram.test(p, siteId);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermission('update', 'Site')
  async disconnect(@Param('siteId') siteId: string, @TenantScope() p: TenantPrincipal): Promise<void> {
    await this.telegram.disconnect(p, siteId);
  }
}

@Module({
  imports: [SitesModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
