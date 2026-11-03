import { formFieldsSchema, type FormField } from '@canon/fields';
import type { Form } from '@canon/db';
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/);

export const formSettingsSchema = z
  .object({
    /** Members (editors and above) get an in-app notification for every non-spam submission. */
    notifyMembers: z.boolean().default(true),
    /** Shown under the submit button: what happens with the data (privacy notice). */
    privacyNote: z.string().max(500).optional(),
  })
  .partial();

export const createFormBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slug.optional(),
  fields: formFieldsSchema,
  successMessage: z.string().max(500).optional(),
  redirectUrl: z
    .string()
    .max(500)
    .regex(/^(\/|https:\/\/)/, 'A path or an https:// URL')
    .optional(),
  notificationEmails: z.array(z.email()).max(10).default([]),
  settings: formSettingsSchema.default({}),
  aiSettings: z
    .object({ spamDetection: z.boolean().default(true) })
    .partial()
    .default({}),
  isActive: z.boolean().default(true),
});
export type CreateFormBody = z.infer<typeof createFormBody>;

export const updateFormBody = createFormBody.partial().extend({
  successMessage: z.string().max(500).nullable().optional(),
  redirectUrl: z
    .string()
    .max(500)
    .regex(/^(\/|https:\/\/)/, 'A path or an https:// URL')
    .nullable()
    .optional(),
});
export type UpdateFormBody = z.infer<typeof updateFormBody>;

export const submissionsQuery = z.object({
  status: z.enum(['NEW', 'READ', 'ARCHIVED', 'SPAM']).optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SubmissionsQuery = z.infer<typeof submissionsQuery>;

export const updateSubmissionBody = z.object({ status: z.enum(['NEW', 'READ', 'ARCHIVED', 'SPAM']) });

/** What arrives from the renderer: field values plus the antispam envelope. */
export const submitBody = z
  .object({
    data: z.record(
      z.string().max(40),
      z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)]),
    ),
    honeypot: z.string().max(500).optional(),
    elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
    path: z.string().max(500).optional(),
    referrer: z.string().max(1_000).optional(),
    locale: z.string().max(10).optional(),
    utm: z
      .object({
        source: z.string().max(100).optional(),
        medium: z.string().max(100).optional(),
        campaign: z.string().max(100).optional(),
      })
      .optional(),
  })
  .strict();
export type SubmitBody = z.infer<typeof submitBody>;

/** The renderer's view: everything needed to draw and post the form, nothing internal. */
export function publicForm(
  f: Pick<Form, 'id' | 'name' | 'fields' | 'successMessage' | 'redirectUrl' | 'settings' | 'isActive'>,
) {
  const fields = (f.fields as unknown as FormField[]).filter((x) => x.type !== 'hidden');
  const settings = (f.settings ?? {}) as { privacyNote?: string };
  return {
    id: f.id,
    name: f.name,
    fields,
    successMessage: f.successMessage ?? null,
    redirectUrl: f.redirectUrl ?? null,
    privacyNote: settings.privacyNote ?? null,
    isActive: f.isActive,
  };
}
export type PublicForm = ReturnType<typeof publicForm>;
