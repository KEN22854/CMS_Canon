import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env';
import { ApiError } from '../../common/http/api-error';

/**
 * The few Stripe calls Canon needs, over plain HTTPS: no SDK, so the surface we depend on is
 * exactly what is listed here and tests can point STRIPE_API_BASE at a local fake.
 */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';
  cancel_at_period_end: boolean;
  /** Since API 2025-03 the period lives on the item; older payloads keep it at the top. */
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

const TOLERANCE_SEC = 300;

@Injectable()
export class StripeClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.STRIPE_SECRET_KEY);
  }

  createCustomer(p: { email: string; name: string; tenantId: string }) {
    return this.call<{ id: string }>('POST', '/v1/customers', { email: p.email, name: p.name, 'metadata[tenantId]': p.tenantId }, `customer-${p.tenantId}`);
  }

  createCheckoutSession(p: { customer: string; price: string; tenantId: string; successUrl: string; cancelUrl: string }) {
    return this.call<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: p.customer,
      client_reference_id: p.tenantId,
      'line_items[0][price]': p.price,
      'line_items[0][quantity]': '1',
      'subscription_data[metadata][tenantId]': p.tenantId,
      allow_promotion_codes: 'true',
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
    });
  }

  createPortalSession(p: { customer: string; returnUrl: string }) {
    return this.call<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: p.customer, return_url: p.returnUrl });
  }

  retrieveSubscription(id: string) {
    return this.call<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  /** Usage-based billing: the meter sums `value` per customer per period. `identifier` dedupes retries. */
  createMeterEvent(p: { eventName: string; customer: string; value: number; identifier: string }) {
    return this.call<{ identifier: string }>('POST', '/v1/billing/meter_events', { event_name: p.eventName, 'payload[stripe_customer_id]': p.customer, 'payload[value]': String(p.value), identifier: p.identifier });
  }

  /**
   * Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">. Any v1 may match (secret
   * rotation sends two); the timestamp bounds replay of a captured payload.
   */
  verifyWebhook(raw: Buffer, header: string | undefined, now = Date.now()): StripeEvent {
    const secret = this.config.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new ApiError('BILLING_DISABLED', 'Stripe webhooks are not configured', 503);
    const parts = (header ?? '').split(',').map((p) => p.split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !sigs.length) throw new ApiError('INVALID_SIGNATURE', 'Missing Stripe signature', 400);
    if (Math.abs(now / 1000 - t) > TOLERANCE_SEC) throw new ApiError('INVALID_SIGNATURE', 'Stripe signature timestamp outside tolerance', 400);
    const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
    const ok = sigs.some((s) => {
      const got = Buffer.from(s, 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    if (!ok) throw new ApiError('INVALID_SIGNATURE', 'Stripe signature mismatch', 400);
    return JSON.parse(raw.toString('utf8')) as StripeEvent;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    if (!this.config.STRIPE_SECRET_KEY) throw new ApiError('BILLING_DISABLED', 'Billing is not configured on this installation', 503);
    const res = await fetch(`${this.config.STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new ApiError('BILLING_PROVIDER_ERROR', body.error?.message ?? `Stripe ${res.status}`, 502);
    return body;
  }
}

/** Test helper and docs reference: the header Stripe would send for `raw`. */
export function signStripePayload(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}
