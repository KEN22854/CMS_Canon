import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8035';
export const PASSWORD = `E2e-${randomBytes(6).toString('hex')}-Pass!`;

/** Polls Mailpit for the newest message to `to` and returns its plain-text body. */
async function lastMailTo(to: string, timeoutMs = 20_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const list = (await res.json()) as { messages?: { ID: string }[] };
    const id = list.messages?.[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string };
      return msg.Text;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No mail to ${to}`);
}

/** Registers through the UI, confirms via the e-mailed link, and lands signed in on the dashboard. */
export async function signUp(page: Page, opts: { workspace?: string } = {}): Promise<{ email: string }> {
  const email = `e2e.${Date.now()}.${randomBytes(3).toString('hex')}@canon.localhost`;
  // Sign-up is rate-limited per client IP (5 per 10 min). Each test presents its own TEST-NET-3
  // address; behind a real ingress a client-supplied X-Forwarded-For is ignored by TRUST_PROXY.
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${1 + (randomBytes(1)[0]! % 254)}` });
  await page.goto('/register');
  await page.getByLabel('Your name').fill('E2E Tester');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Workspace name').fill(opts.workspace ?? 'E2E Workspace');
  await page.getByRole('button', { name: /create|sign up|register/i }).click();
  const text = await lastMailTo(email);
  const link = /https?:\/\/\S*verify-email\?token=[\w-]+/.exec(text)?.[0];
  if (!link) throw new Error('No verification link in the mail');
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page).toHaveURL(/\/$/);
  return { email };
}

/** Creates a site from the Sites page and returns its id (from the URL) and public host. */
export async function createSite(page: Page, name: string): Promise<{ siteId: string; host: string }> {
  await page.goto('/sites');
  await page.getByRole('button', { name: 'New site' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create site' }).click();
  await expect(page).toHaveURL(/\/sites\/[^/]+\/pages$/);
  const siteId = /\/sites\/([^/]+)\/pages/.exec(page.url())![1]!;
  const host = (await page.locator('a', { hasText: '.canon.localhost' }).first().textContent())!.trim();
  return { siteId, host };
}
