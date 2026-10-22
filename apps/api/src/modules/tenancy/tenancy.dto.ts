import { z } from 'zod';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export const memberRole = z.enum(['OWNER', 'ADMIN', 'EDITOR', 'AUTHOR', 'VIEWER']);

const aiSettingsPatch = z
  .object({
    defaultModel: z.string().optional(),
    fallbackModels: z.array(z.string()).max(5).optional(),
    budgetUsd: z.number().nonnegative().max(1_000_000).optional(),
    hardLimit: z.boolean().optional(),
    allowedModels: z.array(z.string()).max(50).optional(),
    brandVoice: z.string().max(2_000).optional(),
    guardrailsPolicy: z
      .object({ piiRedaction: z.boolean().optional(), promptInjection: z.enum(['block', 'log', 'off']).optional() })
      .optional(),
  })
  .strict();

export const createTenantBody = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().regex(SLUG_RE).optional(),
  /** Onboarding template choice; the site itself is created in the Sites module (Phase 2). */
  template: z.enum(['blank', 'blog', 'landing', 'docs', 'ecommerce']).default('blank'),
  ai: aiSettingsPatch.optional(),
});
export type CreateTenantBody = z.infer<typeof createTenantBody>;

export const updateTenantBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    ai: aiSettingsPatch.optional(),
  })
  .strict();
export type UpdateTenantBody = z.infer<typeof updateTenantBody>;

export const inviteBody = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  role: memberRole.default('EDITOR'),
});
export type InviteBody = z.infer<typeof inviteBody>;

export const changeRoleBody = z.object({ role: memberRole });
export type ChangeRoleBody = z.infer<typeof changeRoleBody>;

export const acceptInviteBody = z.object({ token: z.string().min(20).max(200) });
