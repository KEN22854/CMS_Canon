import { isIP } from 'node:net';
import { spamSignals, validateSubmission, type FormField } from '@canon/fields';
import { Prisma, type Form, type FormSubmission } from '@canon/db';
import { AiGateway } from '@canon/ai-gateway';
import { HttpStatus, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { TenantPrincipal } from '../../common/auth/principal';
import { ApiError, conflict, notFound } from '../../common/http/api-error';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { EventBus, Outbox, type StoredEvent } from '../../infrastructure/events/outbox';
import { Mailer } from '../../infrastructure/mail/mailer';
import { PrismaService, SystemPrismaService } from '../../infrastructure/prisma/prisma.service';
import { Queues } from '../../infrastructure/queue/queue.module';
import { REDIS } from '../../infrastructure/redis/redis.module';
import { parseJson } from '../content-ai/ai-content.service';
import { PromptRegistry } from '../intelligence/infrastructure/prompt-registry';
import { NotificationsService } from '../notifications/notifications.service';
import { SitesService } from '../sites/sites.service';
import { slugify } from '../tenancy/tenants.service';
import {
  publicForm,
  type CreateFormBody,
  type SubmissionsQuery,
  type SubmitBody,
  type UpdateFormBody,
} from './forms.dto';

const SPAM_QUEUE = 'form-spam';
/** At or above: stored as SPAM straight away. Between this and CLEAN, the model decides (if enabled). */
const SPAM_AT = 0.8;
const CLEAN_BELOW = 0.2;
const RATE_PER_FORM = 10;
const RATE_WINDOW_SEC = 600;

/** GDPR: keep the network, not the person — /24 for IPv4, /48 for IPv6. */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // IPv4 seen through a dual-stack socket arrives as ::ffff:a.b.c.d.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return truncateIp(mapped[1]);
  const v = isIP(ip);
  if (v === 4) return ip.split('.').slice(0, 3).join('.') + '.0';
  if (v === 6) {
    // Expand "::" so the /48 prefix is always the first three groups.
    const [head = '', tail = ''] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
    return `${groups.slice(0, 3).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::`;
  }
  return null;
}

const csvCell = (v: unknown) => {
  let s = Array.isArray(v) ? v.join('; ') : v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Website forms: definitions, the public submit path, the submissions inbox and delivery. A
 * submission is validated against the form, scored for spam with explainable rules (and a model
 * for the uncertain middle), stored with a truncated IP, and announced through the outbox — so
 * e-mail, in-app notifications, webhooks and CRM plugins all see the same event exactly once.
 */
@Injectable()
export class FormsService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemPrismaService,
    private readonly sites: SitesService,
    private readonly outbox: Outbox,
    private readonly bus: EventBus,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly notifications: NotificationsService,
    private readonly queues: Queues,
    private readonly gateway: AiGateway,
    private readonly prompts: PromptRegistry,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(FormsService.name);
  }

  onApplicationBootstrap(): void {
    this.bus.on('FormSubmitted', (e) => this.onSubmitted(e));
    if (process.env.FORMS_AI === 'off') return;
    this.queues.worker<{ submissionId: string }>(SPAM_QUEUE, (job) => this.classify(job), 2);
  }

  // ── Definitions ─────────────────────────────────────────────────────────────

  async list(tenantId: string, siteId: string) {
    await this.sites.get(tenantId, siteId);
    const rows = await this.prisma
      .forTenant({ tenantId })
      .form.findMany({
        where: { tenantId, siteId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { _count: { select: { submissions: { where: { status: 'NEW' } } } } },
      });
    return rows.map((f) => ({ ...this.present(f), newSubmissions: f._count.submissions }));
  }

  async get(tenantId: string, formId: string): Promise<Form> {
    const f = await this.prisma
      .forTenant({ tenantId })
      .form.findFirst({ where: { id: formId, tenantId, deletedAt: null } });
    if (!f) throw notFound('Form');
    return f;
  }

  present(f: Form) {
    return {
      id: f.id,
      siteId: f.siteId,
      name: f.name,
      slug: f.slug,
      fields: f.fields as unknown as FormField[],
      successMessage: f.successMessage,
      redirectUrl: f.redirectUrl,
      notificationEmails: f.notificationEmails,
      settings: f.settings,
      aiSettings: f.aiSettings,
      isActive: f.isActive,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  }

  async create(actor: TenantPrincipal, siteId: string, body: CreateFormBody) {
    await this.sites.get(actor.tenantId, siteId);
    const slug = body.slug ?? (slugify(body.name) || 'form');
    try {
      const f = await this.prisma.rawForTenant(
        { tenantId: actor.tenantId, userId: actor.userId },
        async (tx) => {
          const created = await tx.form.create({
            data: {
              tenantId: actor.tenantId,
              siteId,
              name: body.name,
              slug,
              fields: body.fields as unknown as Prisma.InputJsonValue,
              successMessage: body.successMessage ?? null,
              redirectUrl: body.redirectUrl ?? null,
              notificationEmails: body.notificationEmails,
              settings: body.settings as Prisma.InputJsonValue,
              aiSettings: body.aiSettings as Prisma.InputJsonValue,
              isActive: body.isActive,
            },
          });
          await this.outbox.enqueue(tx, {
            tenantId: actor.tenantId,
            aggregateType: 'Form',
            aggregateId: created.id,
            type: 'FormUpdated',
            payload: { siteId, formId: created.id },
          });
          return created;
        },
      );
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          action: 'form.created',
          entityType: 'Form',
          entityId: f.id,
          changes: { name: body.name, fields: body.fields.length },
        },
        actor,
      );
      return this.present(f);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw conflict(`A form with slug "${slug}" already exists on this site`);
      throw err;
    }
  }

  async update(actor: TenantPrincipal, formId: string, body: UpdateFormBody) {
    const current = await this.get(actor.tenantId, formId);
    const data: Prisma.FormUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.slug !== undefined) data.slug = body.slug;
    if (body.fields !== undefined) data.fields = body.fields as unknown as Prisma.InputJsonValue;
    if (body.successMessage !== undefined) data.successMessage = body.successMessage;
    if (body.redirectUrl !== undefined) data.redirectUrl = body.redirectUrl;
    if (body.notificationEmails !== undefined) data.notificationEmails = body.notificationEmails;
    if (body.settings !== undefined)
      data.settings = { ...(current.settings as object), ...body.settings } as Prisma.InputJsonValue;
    if (body.aiSettings !== undefined)
      data.aiSettings = { ...(current.aiSettings as object), ...body.aiSettings } as Prisma.InputJsonValue;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    const f = await this.prisma.rawForTenant(
      { tenantId: actor.tenantId, userId: actor.userId },
      async (tx) => {
        const updated = await tx.form.update({ where: { id: formId }, data });
        await this.outbox.enqueue(tx, {
          tenantId: actor.tenantId,
          aggregateType: 'Form',
          aggregateId: formId,
          type: 'FormUpdated',
          payload: { siteId: current.siteId, formId },
        });
        return updated;
      },
    );
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'form.updated',
        entityType: 'Form',
        entityId: formId,
        changes: Object.keys(body),
      },
      actor,
    );
    return this.present(f);
  }

  async remove(actor: TenantPrincipal, formId: string): Promise<void> {
    const f = await this.get(actor.tenantId, formId);
    await this.prisma.rawForTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
      await tx.form.update({ where: { id: formId }, data: { deletedAt: new Date(), isActive: false } });
      await this.outbox.enqueue(tx, {
        tenantId: actor.tenantId,
        aggregateType: 'Form',
        aggregateId: formId,
        type: 'FormUpdated',
        payload: { siteId: f.siteId, formId },
      });
    });
    await this.audit.record(
      { tenantId: actor.tenantId, action: 'form.deleted', entityType: 'Form', entityId: formId },
      actor,
    );
  }

  // ── Public submit ───────────────────────────────────────────────────────────

  /** Called by the renderer (delivery token). Never reveals more than "accepted" or field errors. */
  async submit(
    formId: string,
    body: SubmitBody,
    meta: { ip: string | null; userAgent: string | null; host: string | null; country: string | null },
  ) {
    const form = await this.system.form.findFirst({
      where: { id: formId, deletedAt: null },
      include: {
        site: {
          select: { id: true, internalDomain: true, domain: true, domainStatus: true, deletedAt: true },
        },
      },
    });
    if (!form || !form.isActive || form.site.deletedAt) throw notFound('Form');
    // A form only accepts posts from its own site's hosts.
    const hosts = [
      form.site.internalDomain,
      form.site.domainStatus === 'VERIFIED' ? form.site.domain : null,
    ].filter(Boolean);
    if (meta.host && !hosts.includes(meta.host.toLowerCase())) throw notFound('Form');

    if (meta.ip) {
      const key = `form-rate:${formId}:${meta.ip}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, RATE_WINDOW_SEC);
      if (n > RATE_PER_FORM)
        throw new ApiError(
          'RATE_LIMITED',
          'Too many submissions — try again later',
          HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    const fields = form.fields as unknown as FormField[];
    const result = validateSubmission(fields, body.data);
    if (!result.ok)
      throw new ApiError(
        'INVALID_SUBMISSION',
        'Please check the highlighted fields',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { fields: result.errors },
      );

    const spam = spamSignals(result.data, { honeypot: body.honeypot, elapsedMs: body.elapsedMs });
    const consent = fields
      .filter((f) => f.type === 'consent')
      .map((f) => ({ name: f.name, label: f.label, given: result.data[f.name] === true }));
    const status = spam.score >= SPAM_AT ? 'SPAM' : 'NEW';
    const submission = await this.system.$transaction(async (tx) => {
      const s = await tx.formSubmission.create({
        data: {
          tenantId: form.tenantId,
          formId,
          data: result.data as Prisma.InputJsonValue,
          ipAddress: truncateIp(meta.ip),
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
          status,
          spamScore: spam.score,
          meta: {
            path: body.path ?? null,
            referrer: body.referrer?.slice(0, 500) ?? null,
            locale: body.locale ?? null,
            utm: body.utm ?? null,
            country: meta.country,
            consent,
            spamReasons: spam.reasons,
          } as Prisma.InputJsonValue,
        },
      });
      // Spam never reaches people, webhooks or CRMs.
      if (status !== 'SPAM') {
        await this.outbox.enqueue(tx, {
          tenantId: form.tenantId,
          aggregateType: 'Form',
          aggregateId: formId,
          type: 'FormSubmitted',
          payload: {
            siteId: form.siteId,
            formId,
            formName: form.name,
            submissionId: s.id,
            data: result.data,
            path: body.path ?? null,
          } as Prisma.InputJsonObject,
        });
      }
      return s;
    });
    const ai = (form.aiSettings ?? {}) as { spamDetection?: boolean };
    if (
      status === 'NEW' &&
      spam.score >= CLEAN_BELOW &&
      ai.spamDetection !== false &&
      process.env.FORMS_AI !== 'off'
    ) {
      await this.queues
        .queue(SPAM_QUEUE)
        .add(
          'classify',
          { submissionId: submission.id },
          { jobId: `spam-${submission.id}`, attempts: 2, removeOnComplete: true, removeOnFail: 100 },
        );
    }
    return { accepted: true, successMessage: form.successMessage, redirectUrl: form.redirectUrl };
  }

  /** The model looks only at the uncertain middle; a confident "spam" archives the submission. */
  async classify(job: Pick<Job<{ submissionId: string }>, 'data'>): Promise<void> {
    const s = await this.system.formSubmission.findUnique({
      where: { id: job.data.submissionId },
      include: { form: { select: { name: true, fields: true, tenantId: true } } },
    });
    if (!s || s.status !== 'NEW') return;
    const prompt = await this.prompts.get(s.tenantId, 'forms.classify');
    const { system, user } = this.prompts.render(prompt, {
      form: s.form.name,
      submission: JSON.stringify(s.data).slice(0, 4_000),
    });
    const res = await this.gateway.complete(
      {
        system,
        messages: [{ role: 'user', content: user }],
        preferModel: prompt.modelKey,
        responseFormat: 'json',
        maxTokens: 200,
        cache: 'exact',
      },
      { tenantId: s.tenantId, feature: 'CLASSIFY', promptId: prompt.id, relatedEntity: undefined },
    );
    const out = parseJson<{ spam?: unknown; confidence?: unknown; category?: unknown; summary?: unknown }>(
      res.text,
    );
    if (!out) return;
    const confidence = typeof out.confidence === 'number' ? Math.max(0, Math.min(1, out.confidence)) : 0.5;
    const isSpam = out.spam === true && confidence >= 0.8;
    await this.system.formSubmission.update({
      where: { id: s.id },
      data: {
        aiClassification: {
          spam: out.spam === true,
          confidence,
          category: typeof out.category === 'string' ? out.category.slice(0, 40) : null,
          summary: typeof out.summary === 'string' ? out.summary.slice(0, 300) : null,
          model: res.model,
        } as Prisma.InputJsonValue,
        ...(isSpam ? { status: 'SPAM', spamScore: Math.max(s.spamScore ?? 0, confidence) } : {}),
      },
    });
  }

  private async onSubmitted(e: StoredEvent): Promise<void> {
    const p = e.payload as {
      siteId: string;
      formId: string;
      formName: string;
      submissionId: string;
      data: Record<string, unknown>;
      path: string | null;
    };
    const form = await this.system.form.findUnique({
      where: { id: p.formId },
      select: { notificationEmails: true, settings: true },
    });
    if (!form) return;
    const lines = Object.entries(p.data).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`,
    );
    const text = `New submission to "${p.formName}"${p.path ? ` on ${p.path}` : ''}:\n\n${lines.join('\n')}`;
    // Idempotent per event: the outbox is at-least-once.
    const sentKey = `form-mail:${e.id}`;
    if (form.notificationEmails.length && (await this.redis.set(sentKey, '1', 'EX', 86_400, 'NX'))) {
      for (const to of form.notificationEmails) {
        const html = `<p>New submission to <b>${escapeHtml(p.formName)}</b>${p.path ? ` on ${escapeHtml(p.path)}` : ''}:</p><table>${Object.entries(
          p.data,
        )
          .map(
            ([k, v]) =>
              `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</td></tr>`,
          )
          .join('')}</table>`;
        await this.mailer
          .send({ to, subject: `New submission: ${p.formName}`, text, html, template: 'form.submitted' })
          .catch((err: unknown) => this.logger.warn({ err, formId: p.formId }, 'form.mail_failed'));
      }
    }
    if ((form.settings as { notifyMembers?: boolean }).notifyMembers !== false) {
      await this.notifications.notifyRoles(e.tenantId, ['OWNER', 'ADMIN', 'EDITOR'], {
        type: 'form.submitted',
        title: `New submission: ${p.formName}`,
        message: lines.slice(0, 3).join(' · ').slice(0, 200),
        link: `/sites/${p.siteId}/forms/${p.formId}`,
        data: { formId: p.formId, submissionId: p.submissionId },
        dedupeKey: `form:${p.submissionId}`,
      });
    }
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async submissions(tenantId: string, formId: string, q: SubmissionsQuery) {
    await this.get(tenantId, formId);
    const rows = await this.prisma.forTenant({ tenantId }).formSubmission.findMany({
      where: {
        tenantId,
        formId,
        ...(q.status ? { status: q.status } : { status: { not: 'SPAM' } }),
        ...(q.q ? { data: { string_contains: q.q } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map((s) => this.presentSubmission(s));
    const counts = await this.prisma
      .forTenant({ tenantId })
      .formSubmission.groupBy({ by: ['status'], where: { tenantId, formId }, _count: true });
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  }

  presentSubmission(s: FormSubmission) {
    return {
      id: s.id,
      formId: s.formId,
      data: s.data,
      status: s.status,
      spamScore: s.spamScore,
      aiClassification: s.aiClassification,
      meta: s.meta,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
    };
  }

  private async submission(tenantId: string, id: string) {
    const s = await this.prisma.forTenant({ tenantId }).formSubmission.findFirst({ where: { id, tenantId } });
    if (!s) throw notFound('Submission');
    return s;
  }

  async setStatus(actor: TenantPrincipal, id: string, status: FormSubmission['status']) {
    await this.submission(actor.tenantId, id);
    const s = await this.prisma
      .forTenant({ tenantId: actor.tenantId })
      .formSubmission.update({ where: { id }, data: { status } });
    return this.presentSubmission(s);
  }

  /** GDPR erasure of one submission (a person asked to be forgotten). */
  async deleteSubmission(actor: TenantPrincipal, id: string): Promise<void> {
    const s = await this.submission(actor.tenantId, id);
    await this.prisma.forTenant({ tenantId: actor.tenantId }).formSubmission.delete({ where: { id } });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'form.submission_deleted',
        entityType: 'Form',
        entityId: s.formId,
        changes: { submissionId: id },
      },
      actor,
    );
  }

  async exportCsv(actor: TenantPrincipal, formId: string): Promise<string> {
    const form = await this.get(actor.tenantId, formId);
    const fields = (form.fields as unknown as FormField[]).filter(
      (f) => f.type !== 'hidden' || f.defaultValue !== undefined,
    );
    const rows = await this.prisma
      .forTenant({ tenantId: actor.tenantId })
      .formSubmission.findMany({
        where: { tenantId: actor.tenantId, formId, status: { not: 'SPAM' } },
        orderBy: { createdAt: 'asc' },
        take: 50_000,
      });
    await this.audit.record(
      {
        tenantId: actor.tenantId,
        action: 'form.exported',
        entityType: 'Form',
        entityId: formId,
        changes: { rows: rows.length },
      },
      actor,
    );
    const head = ['createdAt', 'status', ...fields.map((f) => f.name), 'page'].map(csvCell).join(',');
    const body = rows.map((r) => {
      const d = r.data as Record<string, unknown>;
      const m = r.meta as { path?: string | null };
      return [r.createdAt.toISOString(), r.status, ...fields.map((f) => d[f.name]), m.path ?? '']
        .map(csvCell)
        .join(',');
    });
    return `\uFEFF${[head, ...body].join('\n')}\n`;
  }

  publicView(f: Form) {
    return publicForm(f);
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
