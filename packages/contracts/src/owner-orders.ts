import { z } from 'zod';
import { OrderPrintState } from './agent.js';
import { OrderStatus, PrintSettings } from './order.js';

/** Socket.IO event and room names shared by the API and the web app. */
export const REALTIME = {
  /** Client → server: start receiving a shop's queue changes (owners and staff only). */
  watchShop: 'shop:watch',
  /** Client → server: follow one order by its secret token (students). */
  watchOrder: 'order:watch',
  /** Server → client: something in the queue changed; refetch it. Carries no personal data. */
  queueChanged: 'queue:changed',
  /** Server → client: this order changed; refetch it. */
  orderChanged: 'order:changed',
} as const;

/** An online payment as the shop sees it. Orders paid at the counter have none. */
export const OwnerOrderPayment = z.object({
  state: z.enum(['paid', 'refunded', 'refund_failed']),
  /** upi, card, netbanking, wallet, ... */
  method: z.string().nullable(),
  amountPaise: z.number().int(),
  paidAt: z.string().nullable(),
});
export type OwnerOrderPayment = z.infer<typeof OwnerOrderPayment>;

export const OwnerOrderItem = z.object({
  id: z.uuid(),
  originalName: z.string(),
  pageCount: z.number().int(),
  selectedPageCount: z.number().int(),
  settings: PrintSettings,
  printedSides: z.number().int(),
  sheets: z.number().int(),
  amountPaise: z.number().int(),
  /** True once the exact print PDF has been built and can be previewed or downloaded. */
  fileReady: z.boolean(),
});
export type OwnerOrderItem = z.infer<typeof OwnerOrderItem>;

export const OwnerOrder = z.object({
  id: z.uuid(),
  queueNumber: z.string(),
  status: OrderStatus,
  customerName: z.string().nullable(),
  items: z.array(OwnerOrderItem),
  estimatedAmountPaise: z.number().int(),
  finalAmountPaise: z.number().int().nullable(),
  currency: z.string(),
  /** The online payment, or null when the student pays at the counter. */
  payment: OwnerOrderPayment.nullable(),
  /** Set once the shop pressed Print and a printing app is involved. */
  print: OrderPrintState.nullable(),
  rejectionReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type OwnerOrder = z.infer<typeof OwnerOrder>;

export const OwnerQueueResponse = z.object({ orders: z.array(OwnerOrder) });
export type OwnerQueueResponse = z.infer<typeof OwnerQueueResponse>;

/** Online money received, split by how it was paid. */
export const PaymentTotals = z.object({
  method: z.string(),
  count: z.number().int(),
  amountPaise: z.number().int(),
});
export type PaymentTotals = z.infer<typeof PaymentTotals>;

export const OwnerSummary = z.object({
  /** The shop's local date, YYYY-MM-DD. */
  date: z.string(),
  orders: z.number().int(),
  printed: z.number().int(),
  rejected: z.number().int(),
  /** Printed sides (one page printed on one side = 1). */
  pages: z.number().int(),
  /** Online money received today (refunds taken off). */
  collectedPaise: z.number().int(),
  byMethod: z.array(PaymentTotals),
  /** Printed orders the student pays for at the counter: what is still to collect by hand. */
  counterCount: z.number().int(),
  counterPaise: z.number().int(),
  /** Paid orders whose refund did not go through and needs the shop's attention. */
  refundFailed: z.number().int(),
});
export type OwnerSummary = z.infer<typeof OwnerSummary>;

export const MAX_FINAL_AMOUNT_PAISE = 10_000_000;

/** What the shop can do with an order. Print and reject are the daily actions. */
export const OrderActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('print') }),
  /** The printing app failed or the job got stuck: send it again. */
  z.object({ action: z.literal('retry_print') }),
  /** Give up on the printing app for this order and print by hand. */
  z.object({ action: z.literal('print_manually') }),
  z.object({ action: z.literal('reject'), reason: z.string().trim().min(1).max(200) }),
  z.object({
    action: z.literal('complete'),
    /** The amount actually collected, if it differs from the estimate. */
    finalAmountPaise: z.number().int().min(0).max(MAX_FINAL_AMOUNT_PAISE).optional(),
  }),
]);
export type OrderActionBody = z.infer<typeof OrderActionBody>;
