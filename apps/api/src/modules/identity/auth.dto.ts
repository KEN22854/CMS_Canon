import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../../common/crypto/password';

const email = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());
// Strength is checked by zxcvbn in the service (needs the user's name/email as context).
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const token = z.string().min(20).max(200);

export const registerBody = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100),
  tenantName: z.string().trim().min(2).max(80).optional(),
  inviteToken: token.optional(),
  locale: z.string().min(2).max(10).optional(),
});
export type RegisterBody = z.infer<typeof registerBody>;

export const loginBody = z.object({
  email,
  password,
  /** Preferred tenant; defaults to the first membership. */
  tenantSlug: z.string().max(40).optional(),
});
export type LoginBody = z.infer<typeof loginBody>;

export const mfaLoginBody = z.object({
  mfaToken: z.string().min(20),
  /** 6-digit TOTP or a backup code (xxxx-xxxx). */
  code: z.string().trim().min(6).max(12),
});

export const refreshBody = z.object({ refreshToken: token.optional() }).default({});
export const emailBody = z.object({ email });
export const tokenBody = z.object({ token });
export const resetPasswordBody = z.object({ token, password });
export const changePasswordBody = z.object({ currentPassword: password, newPassword: password });
export const switchTenantBody = z.object({ tenantId: z.string().min(1), refreshToken: token.optional() });
export const passwordBody = z.object({ password });
export const codeBody = z.object({ code: z.string().trim().min(6).max(12) });
export const disable2faBody = z.object({ password, code: z.string().trim().min(6).max(12) });
