import { z } from 'zod';

/**
 * Where an order's payment stands. `none` = the student pays at the counter (nothing is tracked);
 * `awaiting` = online payment started but the money has not arrived (the shop does not see the order yet).
 */
export const PaymentState = z.enum(['none', 'awaiting', 'paid', 'refunded', 'refund_failed']);
export type PaymentState = z.infer<typeof PaymentState>;

/** What the student sees about the payment of their order. */
export const OrderPaymentView = z.object({
  state: PaymentState,
  amountPaise: z.number().int(),
  /** upi, card, netbanking, wallet, ... as reported by the gateway. */
  method: z.string().nullable(),
});
export type OrderPaymentView = z.infer<typeof OrderPaymentView>;

/** Everything the browser needs to open the payment window. The secret key never appears here. */
export const CheckoutPayload = z.object({
  keyId: z.string(),
  gatewayOrderId: z.string(),
  amountPaise: z.number().int(),
  currency: z.string(),
  shopName: z.string(),
  prefillName: z.string().nullable(),
  /** True when the shop is using test keys: no real money moves. */
  testMode: z.boolean(),
});
export type CheckoutPayload = z.infer<typeof CheckoutPayload>;

export const PaymentStatusResponse = z.object({
  payment: OrderPaymentView,
  /** Present while the payment is still waiting, so the student can try again. */
  checkout: CheckoutPayload.nullable(),
});
export type PaymentStatusResponse = z.infer<typeof PaymentStatusResponse>;

/** What the payment window hands back after a successful payment. */
export const ConfirmPaymentBody = z.object({
  gatewayOrderId: z.string().min(1).max(64),
  gatewayPaymentId: z.string().min(1).max(64),
  signature: z.string().min(1).max(256),
});
export type ConfirmPaymentBody = z.infer<typeof ConfirmPaymentBody>;

// ---- the shop owner's side ---------------------------------------------------------------

export const PaymentSettingsView = z.object({
  /** True once working keys have been saved. */
  configured: z.boolean(),
  /** True when students are offered online payment. */
  enabled: z.boolean(),
  /** The public key id (safe to show). The secret is never returned. */
  keyId: z.string().nullable(),
  mode: z.enum(['test', 'live']).nullable(),
});
export type PaymentSettingsView = z.infer<typeof PaymentSettingsView>;

export const SavePaymentKeysBody = z.object({
  keyId: z.string().trim().min(8).max(64),
  keySecret: z.string().trim().min(8).max(128),
  /** Turn online payment on straight away. */
  enabled: z.boolean().optional(),
});
export type SavePaymentKeysBody = z.infer<typeof SavePaymentKeysBody>;

export const SetPaymentEnabledBody = z.object({ enabled: z.boolean() });
export type SetPaymentEnabledBody = z.infer<typeof SetPaymentEnabledBody>;

/** The smallest amount the gateway accepts, in paise. Cheaper orders are paid at the counter. */
export const MIN_ONLINE_PAYMENT_PAISE = 100;
