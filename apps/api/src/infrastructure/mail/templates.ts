import type { MailMessage } from './mailer';

/**
 * Plain, accessible transactional emails. Links are built from ADMIN_PUBLIC_URL only — never from
 * request headers — so a forged Host header cannot turn a reset email into a phishing link.
 */
function layout(title: string, body: string, cta?: { label: string; href: string }): string {
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.href)}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p><p style="color:#6b7280;font-size:12px">Or paste this link: ${escapeHtml(cta.href)}</p>`
    : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111827;max-width:560px;margin:auto;padding:24px"><h1 style="font-size:20px">${escapeHtml(title)}</h1>${body}${button}<p style="color:#9ca3af;font-size:12px;margin-top:32px">Canon CMS</p></body></html>`;
}

const p = (text: string) => `<p>${escapeHtml(text)}</p>`;

export function verifyEmailMail(to: string, link: string): MailMessage {
  return {
    to,
    template: 'verify-email',
    subject: 'Confirm your email for Canon',
    text: `Confirm your email to finish signing up: ${link}\nThe link expires in 24 hours.`,
    html: layout('Confirm your email', p('Confirm your email address to finish signing up. The link expires in 24 hours.'), { label: 'Confirm email', href: link }),
  };
}

export function accountExistsMail(to: string, loginLink: string, resetLink: string): MailMessage {
  return {
    to,
    template: 'account-exists',
    subject: 'Someone tried to sign up with your email',
    text: `An account for this email already exists. Sign in: ${loginLink}\nForgot your password? ${resetLink}\nIf this wasn't you, you can ignore this email.`,
    html: layout('You already have an account', p('Someone (hopefully you) tried to sign up with this email. If it was you, just sign in. If not, you can ignore this message.'), { label: 'Sign in', href: loginLink }),
  };
}

export function resetPasswordMail(to: string, link: string): MailMessage {
  return {
    to,
    template: 'reset-password',
    subject: 'Reset your Canon password',
    text: `Reset your password: ${link}\nThe link expires in 1 hour. If you didn't ask for this, ignore this email.`,
    html: layout('Reset your password', p('The link expires in 1 hour and works once. If you did not request a reset, ignore this email — your password is unchanged.'), { label: 'Choose a new password', href: link }),
  };
}

export function passwordChangedMail(to: string): MailMessage {
  return {
    to,
    template: 'password-changed',
    subject: 'Your Canon password was changed',
    text: 'Your password was changed and all other sessions were signed out. If this was not you, reset your password immediately and contact support.',
    html: layout('Password changed', p('Your password was changed and all sessions were signed out. If this was not you, reset your password immediately and contact your workspace owner.')),
  };
}

export function invitationMail(to: string, tenantName: string, inviterName: string, role: string, link: string): MailMessage {
  return {
    to,
    template: 'invitation',
    subject: `${inviterName} invited you to ${tenantName} on Canon`,
    text: `${inviterName} invited you to join "${tenantName}" as ${role}. Accept: ${link}\nThe invitation expires in 7 days.`,
    html: layout(`Join ${tenantName}`, p(`${inviterName} invited you to join "${tenantName}" as ${role}. The invitation expires in 7 days.`), { label: 'Accept invitation', href: link }),
  };
}

export function aiBudgetAlertMail(to: string, tenantName: string, percent: number, spentUsd: number, budgetUsd: number, link: string): MailMessage {
  return {
    to,
    template: 'ai-budget-alert',
    subject: `${tenantName}: ${percent}% of the monthly AI budget used`,
    text: `${tenantName} has used $${spentUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} monthly AI budget (${percent}%). Details: ${link}`,
    html: layout(`${percent}% of AI budget used`, p(`${tenantName} has used $${spentUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} monthly AI budget.`), { label: 'View AI usage', href: link }),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
