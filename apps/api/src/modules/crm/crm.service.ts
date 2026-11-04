import { formatMoney } from '@canon/blocks';
import type { FormField } from '@canon/fields';
import { Prisma, type Automation, type Contact } from '@canon/db';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { badRequest, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { EventBus, type StoredEvent } from '../../infrastructure/events/outbox';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { automationAction, automationTrigger, renderTemplate, type AutomationAction, type AutomationBody, type AutomationEvent, type AutomationTrigger, type ListContactsQuery, type UpdateAutomationBody, type UpdateContactBody } from './crm.dto';

type Db = Prisma.TransactionClient | SystemPrismaService;

interface Happening {
  event: AutomationEvent;
  eventId: string;
  tenantId: string;
  siteId: string;
  contact: Contact;
  vars: Record<string, string>;
  formId?: string;
  status?: string;
  total?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * CRM (Stage 8). Contacts are built from what visitors do — a form submission or an order — by
 * outbox handlers on the system role (the visitor has no tenant); the outbox retries failures, so
 * every write is idempotent: one activity per (contact, kind, source) and one run per (automation,
 * event). Automations then act on the same happening: an email to the contact or the team, a tag.
 */
@Injectable()
export class CrmService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly bus: EventBus,
    private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CrmService.name);
  }

  onApplicationBootstrap(): void {
    this.bus.on('FormSubmitted', (e) => this.onForm(e));
    this.bus.on('OrderPlaced', (e) => this.onOrder(e));
    this.bus.on('OrderStatusChanged', (e) => this.onOrderStatus(e));
  }

  // ── ingestion ──────────────────────────────────────────────────────────────

  private async onForm(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; formId: string; formName: string; submissionId: string; data: Record<string, unknown> };
    const form = await this.system.form.findFirst({ where: { id: p.formId }, select: { fields: true } });
    const fields = (form?.fields ?? []) as unknown as FormField[];
    const pick = (type: string, name?: RegExp) => {
      const f = fields.find((x) => x.type === type && (!name || name.test(x.name))) ?? (name ? fields.find((x) => name.test(x.name) && x.type !== 'consent') : undefined);
      const v = f ? p.data[f.name] : undefined;
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const email = pick('email', /e-?mail/i)?.toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return; // no address, no contact
    const name = pick('text', /^(full_?)?name$|^имя/i);
    const phone = pick('phone', /phone|tel/i);
    const contact = await this.upsertContact(e.tenantId, p.siteId, email, { name, phone });
    await this.addActivity(this.system, e.tenantId, contact.id, 'form', `Form “${p.formName}”`, { formId: p.formId, submissionId: p.submissionId, data: p.data as Prisma.InputJsonObject }, p.submissionId);
    await this.runAutomations({ event: 'form.submitted', eventId: e.id, tenantId: e.tenantId, siteId: p.siteId, contact, formId: p.formId, vars: { 'form.name': p.formName } });
  }

  private async onOrder(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; orderId: string };
    const order = await this.system.order.findFirst({ where: { id: p.orderId } });
    if (!order) return;
    const c = order.customer as { name?: string; email: string; phone?: string };
    const email = c.email.toLowerCase();
    const total = formatMoney(order.total, order.currency, order.locale);
    const contact = await this.system.$transaction(async (tx) => {
      const ct = await this.upsertContact(e.tenantId, p.siteId, email, { name: c.name, phone: c.phone }, tx);
      // Counting happens once per order: the activity insert is the idempotency key.
      if (await this.addActivity(tx, e.tenantId, ct.id, 'order', `Order #${order.number} — ${total}`, { orderId: order.id, number: order.number, total: order.total, currency: order.currency }, order.id)) {
        const revenue = { ...((ct.revenue as Record<string, number>) ?? {}) };
        revenue[order.currency] = (revenue[order.currency] ?? 0) + order.total;
        return tx.contact.update({ where: { id: ct.id }, data: { orderCount: { increment: 1 }, revenue, lastSeenAt: new Date() } });
      }
      return ct;
    });
    await this.runAutomations({ event: 'order.placed', eventId: e.id, tenantId: e.tenantId, siteId: p.siteId, contact, total: order.total, vars: { 'order.number': String(order.number), 'order.total': total, 'order.status': order.status } });
  }

  private async onOrderStatus(e: StoredEvent): Promise<void> {
    const p = e.payload as { siteId: string; orderId: string; number: number; status: string };
    const order = await this.system.order.findFirst({ where: { id: p.orderId } });
    if (!order) return;
    const email = (order.customer as { email: string }).email.toLowerCase();
    const contact = await this.system.contact.findFirst({ where: { siteId: p.siteId, email } });
    if (!contact) return;
    if (p.status === 'CANCELLED') {
      // A cancelled order doesn't count as money spent.
      const revenue = { ...((contact.revenue as Record<string, number>) ?? {}) };
      revenue[order.currency] = Math.max(0, (revenue[order.currency] ?? 0) - order.total);
      if (await this.addActivity(this.system, e.tenantId, contact.id, 'order_status', `Order #${p.number}: ${p.status}`, { orderId: order.id, status: p.status }, e.id))
        await this.system.contact.update({ where: { id: contact.id }, data: { orderCount: { decrement: contact.orderCount > 0 ? 1 : 0 }, revenue } });
    } else {
      await this.addActivity(this.system, e.tenantId, contact.id, 'order_status', `Order #${p.number}: ${p.status}`, { orderId: order.id, status: p.status }, e.id);
    }
    await this.runAutomations({ event: 'order.status', eventId: e.id, tenantId: e.tenantId, siteId: p.siteId, contact, status: p.status, total: order.total, vars: { 'order.number': String(p.number), 'order.total': formatMoney(order.total, order.currency, order.locale), 'order.status': p.status } });
  }

  private async upsertContact(tenantId: string, siteId: string, email: string, info: { name?: string; phone?: string }, db: Db = this.system): Promise<Contact> {
    const name = info.name?.slice(0, 120) || undefined;
    const phone = info.phone?.slice(0, 40) || undefined;
    const c = await db.contact.upsert({ where: { siteId_email: { siteId, email } }, create: { tenantId, siteId, email, name: name ?? null, phone: phone ?? null }, update: { lastSeenAt: new Date() } });
    // Newer details fill gaps; they don't overwrite what is known (or what the team typed in).
    const fill = { ...(name && !c.name ? { name } : {}), ...(phone && !c.phone ? { phone } : {}) };
    return Object.keys(fill).length ? db.contact.update({ where: { id: c.id }, data: fill }) : c;
  }

  /** false when this source was recorded before (a retried event). */
  private async addActivity(db: Db, tenantId: string, contactId: string, kind: string, title: string, data: Prisma.InputJsonObject, refId: string | null, createdById?: string): Promise<boolean> {
    try {
      await db.contactActivity.create({ data: { tenantId, contactId, kind, title: title.slice(0, 200), data, refId, createdById: createdById ?? null } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  // ── automations ────────────────────────────────────────────────────────────

  private async runAutomations(h: Happening): Promise<void> {
    const list = await this.system.automation.findMany({ where: { siteId: h.siteId, enabled: true } });
    const site = await this.system.site.findFirst({ where: { id: h.siteId }, select: { name: true } });
    const vars = { ...h.vars, 'contact.name': h.contact.name ?? '', 'contact.email': h.contact.email, 'site.name': site?.name ?? '' };
    for (const a of list) {
      const trigger = automationTrigger.safeParse(a.trigger);
      if (!trigger.success || !matches(trigger.data, h)) continue;
      // One run per automation and event: a retried event doesn't email twice.
      try {
        await this.system.automationRun.create({ data: { tenantId: h.tenantId, automationId: a.id, eventId: h.eventId, contactId: h.contact.id, status: 'running' } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
      const done: string[] = [];
      let status = 'ok';
      for (const raw of (a.actions as unknown[]) ?? []) {
        const act = automationAction.safeParse(raw);
        if (!act.success) continue;
        try {
          await this.act(act.data, h, vars);
          done.push(act.data.type);
        } catch (err) {
          status = 'failed';
          this.logger.warn({ err, automationId: a.id }, 'automation action failed');
        }
      }
      await this.system.automationRun.update({ where: { automationId_eventId: { automationId: a.id, eventId: h.eventId } }, data: { status, detail: { actions: done, event: h.event } } });
      await this.system.automation.update({ where: { id: a.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
    }
  }

  private async act(action: AutomationAction, h: Happening, vars: Record<string, string>): Promise<void> {
    switch (action.type) {
      case 'add_tag': {
        const c = await this.system.contact.findUniqueOrThrow({ where: { id: h.contact.id } });
        if (!c.tags.includes(action.tag)) await this.system.contact.update({ where: { id: c.id }, data: { tags: [...c.tags, action.tag].slice(0, 30) } });
        return;
      }
      case 'email_contact':
      case 'email_team': {
        const to = action.type === 'email_contact' ? h.contact.email : action.to;
        const subject = renderTemplate(action.subject, vars).slice(0, 200);
        const text = renderTemplate(action.body, vars);
        await this.mailer.send({ to, subject, text, html: plainHtml(text), template: `automation-${action.type}` });
        await this.addActivity(this.system, h.tenantId, h.contact.id, 'email', `${action.type === 'email_contact' ? 'Email sent' : 'Team notified'}: ${subject}`, { to: action.type === 'email_team' ? 'team' : 'contact', subject }, `${h.eventId}:${action.type}:${to}`);
        return;
      }
    }
  }

  // ── contacts (the admin) ───────────────────────────────────────────────────

  async list(tenantId: string, siteId: string, q: ListContactsQuery) {
    await this.sites.get(tenantId, siteId);
    const db = this.prisma.forTenant({ tenantId });
    const where: Prisma.ContactWhereInput = {
      tenantId,
      siteId,
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.customers ? { orderCount: { gt: 0 } } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q.toLowerCase() } }, { name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] } : {}),
    };
    const [items, total, tagRows] = await Promise.all([
      db.contact.findMany({ where, orderBy: { lastSeenAt: 'desc' }, skip: q.offset, take: q.limit }),
      db.contact.count({ where }),
      this.prisma.rawForTenant({ tenantId }, (tx) => tx.$queryRaw<{ tag: string; n: bigint }[]>`SELECT unnest(tags) AS tag, count(*)::bigint AS n FROM contacts WHERE "siteId" = ${siteId} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30`),
    ]);
    return { items: items.map(present), total, tags: tagRows.map((r) => ({ tag: r.tag, count: Number(r.n) })) };
  }

  async get(tenantId: string, siteId: string, id: string) {
    const db = this.prisma.forTenant({ tenantId });
    const c = await db.contact.findFirst({ where: { id, siteId, tenantId } });
    if (!c) throw notFound('Contact');
    const activities = await db.contactActivity.findMany({ where: { contactId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { ...present(c), activities: activities.map((a) => ({ id: a.id, kind: a.kind, title: a.title, data: a.data, createdAt: a.createdAt })) };
  }

  async update(actor: TenantPrincipal, siteId: string, id: string, body: UpdateContactBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const c = await db.contact.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!c) throw notFound('Contact');
    await db.contact.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name || null } : {}), ...(body.phone !== undefined ? { phone: body.phone || null } : {}), ...(body.tags ? { tags: [...new Set(body.tags)] } : {}) } });
    return this.get(actor.tenantId, siteId, id);
  }

  async note(actor: TenantPrincipal, siteId: string, id: string, text: string) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const c = await db.contact.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!c) throw notFound('Contact');
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) => this.addActivity(tx, actor.tenantId, id, 'note', text.slice(0, 200), { text }, null, actor.userId ?? undefined));
    return this.get(actor.tenantId, siteId, id);
  }

  /** Right to erasure: the contact and its timeline go; orders and submissions keep their own rows. */
  async remove(actor: TenantPrincipal, siteId: string, id: string): Promise<void> {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const c = await db.contact.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!c) throw notFound('Contact');
    await db.contact.delete({ where: { id } });
    await this.audit.record({ tenantId: actor.tenantId, action: 'contact.deleted', entityType: 'Contact', entityId: id }, actor);
  }

  // ── automations (the admin) ────────────────────────────────────────────────

  async automations(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma.forTenant({ tenantId }).automation.findMany({ where: { tenantId, siteId }, orderBy: { createdAt: 'asc' } });
    return rows.map(presentAutomation);
  }

  async createAutomation(actor: TenantPrincipal, siteId: string, body: AutomationBody) {
    await this.sites.get(actor.tenantId, siteId);
    await this.assertForm(actor.tenantId, siteId, body.trigger);
    const a = await this.prisma.forTenant({ tenantId: actor.tenantId }).automation.create({
      data: { tenantId: actor.tenantId, siteId, name: body.name, enabled: body.enabled, trigger: body.trigger, actions: body.actions as Prisma.InputJsonValue, createdById: actor.userId ?? null },
    });
    await this.audit.record({ tenantId: actor.tenantId, action: 'automation.created', entityType: 'Automation', entityId: a.id, changes: { event: body.trigger.event, actions: body.actions.map((x) => x.type) } }, actor);
    return presentAutomation(a);
  }

  async updateAutomation(actor: TenantPrincipal, siteId: string, id: string, body: UpdateAutomationBody) {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const a = await db.automation.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!a) throw notFound('Automation');
    if (body.trigger) await this.assertForm(actor.tenantId, siteId, body.trigger);
    const next = await db.automation.update({ where: { id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.trigger ? { trigger: body.trigger } : {}), ...(body.actions ? { actions: body.actions as Prisma.InputJsonValue } : {}) } });
    return presentAutomation(next);
  }

  async removeAutomation(actor: TenantPrincipal, siteId: string, id: string): Promise<void> {
    const db = this.prisma.forTenant({ tenantId: actor.tenantId });
    const a = await db.automation.findFirst({ where: { id, siteId, tenantId: actor.tenantId } });
    if (!a) throw notFound('Automation');
    await db.automation.delete({ where: { id } });
  }

  async runs(tenantId: string, siteId: string, id: string) {
    const db = this.prisma.forTenant({ tenantId });
    const a = await db.automation.findFirst({ where: { id, siteId, tenantId } });
    if (!a) throw notFound('Automation');
    const rows = await db.automationRun.findMany({ where: { automationId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => ({ id: r.id, status: r.status, contactId: r.contactId, detail: r.detail, createdAt: r.createdAt }));
  }

  private async assertForm(tenantId: string, siteId: string, trigger: AutomationTrigger): Promise<void> {
    if (trigger.event !== 'form.submitted' || !trigger.formId) return;
    const f = await this.prisma.forTenant({ tenantId }).form.findFirst({ where: { id: trigger.formId, siteId, tenantId, deletedAt: null }, select: { id: true } });
    if (!f) throw badRequest('INVALID_TRIGGER', 'The form is not one of this site');
  }
}

function matches(t: AutomationTrigger, h: Happening): boolean {
  if (t.event !== h.event) return false;
  if (t.formId && t.formId !== h.formId) return false;
  if (t.status && t.status !== h.status) return false;
  if (t.minTotal !== undefined && (h.total ?? 0) < t.minTotal) return false;
  return true;
}

/** Automation texts are plain: escaped, paragraphs and line breaks kept. */
function plainHtml(text: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;margin:auto;padding:24px">${text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')}</body></html>`;
}

function present(c: Contact) {
  return { id: c.id, email: c.email, name: c.name, phone: c.phone, tags: c.tags, orderCount: c.orderCount, revenue: c.revenue as Record<string, number>, firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt };
}

function presentAutomation(a: Automation) {
  return { id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger as AutomationTrigger, actions: a.actions as AutomationAction[], runCount: a.runCount, lastRunAt: a.lastRunAt, createdAt: a.createdAt };
}
