import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from '@canon/blocks';
import { PAYMENT_METHODS } from '@canon/fields';
import { z } from 'zod';
import { LOCALE_RE } from '../sites/sites.dto';

const productId = z.string().regex(/^[a-z0-9]{8,40}$/i);

/** What the site's checkout posts: ids and quantities only — every amount is computed here. */
export const checkoutBody = z.object({
  items: z
    .array(z.object({ productId, quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }))
    .min(1)
    .max(MAX_ORDER_LINES),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().max(40).optional(),
    address: z.string().trim().max(500).optional(),
    note: z.string().trim().max(1_000).optional(),
  }),
  paymentMethod: z.enum(PAYMENT_METHODS),
  locale: z.string().regex(LOCALE_RE).optional(),
  honeypot: z.string().max(500).optional(),
  elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type CheckoutBody = z.infer<typeof checkoutBody>;

export const ORDER_STATUSES = ['NEW', 'CONFIRMED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'] as const;
export type OrderStatusName = (typeof ORDER_STATUSES)[number];

/** Allowed moves; anything else is a 409. Cancelling returns the stock. */
export const ORDER_TRANSITIONS: Record<OrderStatusName, readonly OrderStatusName[]> = {
  NEW: ['CONFIRMED', 'PAID', 'CANCELLED'],
  CONFIRMED: ['PAID', 'SHIPPED', 'CANCELLED'],
  PAID: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const listOrdersQuery = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuery>;

export const updateOrderBody = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500).optional(),
});
export type UpdateOrderBody = z.infer<typeof updateOrderBody>;

export interface OrderItem {
  entryId: string;
  slug: string;
  title: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}
