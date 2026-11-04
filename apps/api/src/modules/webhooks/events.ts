import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
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
  'form.submitted': 'FormSubmitted',
  'order.placed': 'OrderPlaced',
  'order.cancelled': 'OrderCancelled',
  'order.status': 'OrderStatusChanged',
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

export interface VettedTarget {
  /** The address the connection must use; null when private targets are allowed (development). */
  address: string | null;
  family: 4 | 6;
}

/**
 * SSRF guard for outbound deliveries: HTTPS only, and the host must resolve to public addresses
 * only. Returns the vetted address so the caller connects to exactly that IP (see pinnedFetch):
 * resolving again at connect time would reopen a DNS-rebinding window. Development may target
 * private hosts so local receivers work.
 */
export async function assertDeliverableUrl(raw: string, allowPrivate: boolean): Promise<VettedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('INVALID_WEBHOOK_URL', 'Not a valid URL', 400);
  }
  if (url.username || url.password) throw new ApiError('INVALID_WEBHOOK_URL', 'Credentials in the URL are not allowed — use the signing secret', 400);
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new ApiError('INVALID_WEBHOOK_URL', 'Webhook URLs must use HTTPS', 400);
  if (allowPrivate) return { address: null, family: 4 };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new ApiError('INVALID_WEBHOOK_URL', `Cannot resolve ${host}`, 400);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new ApiError('INVALID_WEBHOOK_URL', 'Webhook URLs must point to a public address', 400);
  return { address: addrs[0]!.address, family: addrs[0]!.family === 6 ? 6 : 4 };
}

/**
 * fetch() that connects to the vetted IP while keeping the URL's host for TLS (SNI, certificate
 * check) and the Host header. With no vetted address it is a plain fetch.
 */
export async function pinnedFetch(url: string, target: VettedTarget, init: RequestInit): Promise<Response> {
  if (!target.address) return fetch(url, init);
  const agent = new Agent({
    connect: {
      lookup: (_host, _opts, cb) => cb(null, [{ address: target.address!, family: target.family }]),
    },
  });
  try {
    // undici's fetch is the implementation behind global fetch; it accepts the pinned dispatcher.
    const res = await undiciFetch(url, { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: agent });
    // Buffer the body so the agent can close; webhook responses are read capped anyway.
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()) });
  } finally {
    await agent.close();
  }
}
