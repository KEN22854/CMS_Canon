import { z } from 'zod';

const tag = z.string().trim().toLowerCase().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u, 'Letters, digits, spaces, - and _');

export const listContactsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tag: tag.optional(),
  customers: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListContactsQuery = z.infer<typeof listContactsQuery>;

export const updateContactBody = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  tags: z.array(tag).max(30).optional(),
});
export type UpdateContactBody = z.infer<typeof updateContactBody>;

export const noteBody = z.object({ text: z.string().trim().min(1).max(2_000) });

export const AUTOMATION_EVENTS = ['form.submitted', 'order.placed', 'order.status'] as const;
export type AutomationEvent = (typeof AUTOMATION_EVENTS)[number];

export const automationTrigger = z
  .object({
    event: z.enum(AUTOMATION_EVENTS),
    /** form.submitted: only this form (empty = any form of the site). */
    formId: z.string().max(40).optional(),
    /** order.status: only moves to this status. */
    status: z.enum(['CONFIRMED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED']).optional(),
    /** order.*: only orders of at least this total (minor units). */
    minTotal: z.number().int().min(0).max(2_000_000_000).optional(),
  })
  .strict();
export type AutomationTrigger = z.infer<typeof automationTrigger>;

/** Text with {{contact.name}}, {{order.number}}… — rendered as plain text (HTML-escaped in mails). */
const template = (max: number) => z.string().trim().min(1).max(max);

export const automationAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email_contact'), subject: template(200), body: template(5_000) }).strict(),
  z.object({ type: z.literal('email_team'), to: z.string().trim().toLowerCase().email().max(254), subject: template(200), body: template(5_000) }).strict(),
  z.object({ type: z.literal('add_tag'), tag }).strict(),
  /** A message to the site's Telegram chat (Integrations → Telegram). */
  z.object({ type: z.literal('telegram'), text: template(3_000) }).strict(),
]);
export type AutomationAction = z.infer<typeof automationAction>;

export const automationBody = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  trigger: automationTrigger,
  actions: z.array(automationAction).min(1).max(5),
});
export type AutomationBody = z.infer<typeof automationBody>;
export const updateAutomationBody = automationBody.partial();
export type UpdateAutomationBody = z.infer<typeof updateAutomationBody>;

/** Variables an automation's texts may use. Unknown ones render empty. */
export const TEMPLATE_VARIABLES = ['contact.name', 'contact.email', 'site.name', 'form.name', 'order.number', 'order.total', 'order.status'] as const;

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}
