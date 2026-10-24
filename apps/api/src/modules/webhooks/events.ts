import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '../../common/http/api-error';

/** Public webhook event names (stable API) → internal outbox event types. */
export const WEBHOOK_EVENTS = {
  'page.updated': 'PageChanged',
  'page.published': 'PagePublished',
  'page.unpublished': 'PageUnpublished',
  'page.moved': 'PageMoved',
  'entry.updated': 'EntryChanged',
  'entry.published': 'EntryPublished',
  'entry.unpublished': 'EntryUnpublished',
  'collection.updated': 'CollectionUpdated',
  'collection.deleted': 'CollectionDeleted',
  'site.created': 'SiteCreated',
  'site.updated': 'SiteUpdated',
  'site.deleted': 'SiteDeleted',
  'fact.changed': 'FactChanged',
  'experiment.changed': 'ExperimentChanged',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_NAMES = Object.keys(WEBHOOK_EVENTS) as WebhookEvent[];
export const EVENT_BY_TYPE = new Map<string, WebhookEvent>(Object.entries(WEBHOOK_EVENTS).map(([name, type]) => [type, name as WebhookEvent]));

/** Canon-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<body>")) — same scheme as Stripe. */
export function signWebhook(body: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^22[4-9]\.|^2[3-5]\d\./];
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * SSRF guard for outbound deliveries: HTTPS only, and the host must resolve to public addresses
 * (checked at save time and again before every delivery, against DNS rebinding). Development
 * may target private hosts so local receivers work.
 */
export async function assertDeliverableUrl(raw: string, allowPrivate: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('INVALID_WEBHOOK_URL', 'Not a valid URL', 400);
  }
  if (url.username || url.password) throw new ApiError('INVALID_WEBHOOK_URL', 'Credentials in the URL are not allowed — use the signing secret', 400);
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new ApiError('INVALID_WEBHOOK_URL', 'Webhook URLs must use HTTPS', 400);
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new ApiError('INVALID_WEBHOOK_URL', `Cannot resolve ${host}`, 400);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new ApiError('INVALID_WEBHOOK_URL', 'Webhook URLs must point to a public address', 400);
}
