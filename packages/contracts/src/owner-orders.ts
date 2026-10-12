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
