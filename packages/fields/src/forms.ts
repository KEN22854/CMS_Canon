import { z } from 'zod';

/**
 * Website forms (lead, contact, demo request…). One definition drives the admin form builder, the
 * renderer's HTML and the API's validation, so what a visitor can submit is exactly what the
 * editor designed — never more fields, never other types.
 */
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'consent',
  'date',
  'hidden',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_FIELD_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;
/** Names the antispam layer reserves on the wire. */
const RESERVED = new Set(['_hp', '_elapsed', '_path', '_redirect']);

export const formFieldSchema = z
  .object({
    name: z.string().regex(FORM_FIELD_NAME_RE, 'lowercase letters, digits and _; starts with a letter'),
    type: z.enum(FORM_FIELD_TYPES),
    label: z.string().trim().min(1).max(200),
    required: z.boolean().default(false),
    placeholder: z.string().max(120).optional(),
    help: z.string().max(300).optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
    width: z.enum(['full', 'half']).default('full'),
    /** Hidden fields: a fixed value (e.g. "campaign") the form always sends. */
    defaultValue: z.string().max(200).optional(),
  })
  .superRefine((f, ctx) => {
    if (RESERVED.has(f.name))
      ctx.addIssue({ code: 'custom', path: ['name'], message: `"${f.name}" is reserved` });
    if ((f.type === 'select' || f.type === 'multiselect') && !f.options?.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Choices need at least one option' });
    if (f.type === 'consent' && !f.required)
      ctx.addIssue({ code: 'custom', path: ['required'], message: 'Consent checkboxes are always required' });
  });
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldInput = z.input<typeof formFieldSchema>;

export const formFieldsSchema = z
  .array(formFieldSchema)
  .min(1)
  .max(30)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.name))
        ctx.addIssue({ code: 'custom', path: [i, 'name'], message: `Duplicate field "${f.name}"` });
      seen.add(f.name);
    });
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s().-]{6,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX = { text: 300, textarea: 5_000 } as const;

export type SubmissionValue = string | number | boolean | string[];
export type SubmissionData = Record<string, SubmissionValue>;

/**
 * Cleans and validates raw input (JSON or form-encoded) against the form. Unknown keys are dropped;
 * strings are trimmed; checkboxes accept "on"/"true"/true. Returns field-level errors for the UI.
 */
export function validateSubmission(
  fields: readonly FormField[],
  raw: Record<string, unknown>,
): { ok: true; data: SubmissionData } | { ok: false; errors: Record<string, string> } {
  const data: SubmissionData = {};
  const errors: Record<string, string> = {};
  const truthy = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes';
  for (const f of fields) {
    const v = raw[f.name];
    if (f.type === 'hidden') {
      if (f.defaultValue !== undefined) data[f.name] = f.defaultValue;
      continue;
    }
    if (f.type === 'checkbox' || f.type === 'consent') {
      const on = truthy(v);
      if (f.required && !on) errors[f.name] = f.type === 'consent' ? 'Please give your consent' : 'Required';
      data[f.name] = on;
      continue;
    }
    if (f.type === 'multiselect') {
      const list = (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []).map(String);
      const bad = list.filter((x) => !f.options!.includes(x));
      if (bad.length) errors[f.name] = 'Choose from the list';
      else if (f.required && !list.length) errors[f.name] = 'Required';
      else if (list.length) data[f.name] = list;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    if (!s) {
      if (f.required) errors[f.name] = 'Required';
      continue;
    }
    const max = f.maxLength ?? (f.type === 'textarea' ? DEFAULT_MAX.textarea : DEFAULT_MAX.text);
    if (s.length > max) {
      errors[f.name] = `At most ${max} characters`;
      continue;
    }
    switch (f.type) {
      case 'email':
        if (!EMAIL_RE.test(s)) errors[f.name] = 'Enter a valid email';
        else data[f.name] = s.toLowerCase();
        break;
      case 'phone':
        if (!PHONE_RE.test(s)) errors[f.name] = 'Enter a valid phone number';
        else data[f.name] = s;
        break;
      case 'number': {
        const n = Number(s.replace(',', '.'));
        if (!Number.isFinite(n)) errors[f.name] = 'Enter a number';
        else data[f.name] = n;
        break;
      }
      case 'date':
        if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) errors[f.name] = 'Enter a date';
        else data[f.name] = s;
        break;
      case 'select':
        if (!f.options!.includes(s)) errors[f.name] = 'Choose from the list';
        else data[f.name] = s;
        break;
      default:
        data[f.name] = s;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
}

/**
 * Cheap, explainable spam signals (0 = clean, 1 = certainly spam), applied before any model.
 * The honeypot and time-to-submit come from the renderer; the rest looks at the content.
 */
export function spamSignals(
  data: SubmissionData,
  meta: { honeypot?: string; elapsedMs?: number },
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const flag = (weight: number, reason: string) => {
    score += weight;
    reasons.push(reason);
  };
  if (meta.honeypot) flag(1, 'honeypot filled');
  if (meta.elapsedMs !== undefined && meta.elapsedMs < 2_500) flag(0.6, 'submitted too fast');
  const text = Object.values(data)
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  const links = (text.match(/https?:\/\/|www\./gi) ?? []).length;
  if (links >= 3) flag(0.5, 'many links');
  else if (links >= 1 && text.length < 80) flag(0.2, 'short message with a link');
  if (/\b(viagra|casino|crypto ?(airdrop|giveaway)|seo services|backlinks|loan offer)\b/i.test(text))
    flag(0.6, 'spam phrases');
  if (/[\u0400-\u04FF]/.test(text) && /[\u4E00-\u9FFF]/.test(text)) flag(0.2, 'mixed scripts');
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}
