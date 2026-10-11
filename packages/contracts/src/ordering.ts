import { z } from 'zod';
import { ColorMode, OrderStatus, PaperSize, PrintSettings, Sides } from './order.js';
import { UPLOAD_TOKEN_PATTERN } from './uploads.js';

/** A print setting set the student can submit; custom page selections need a page list. */
export const PrintSettingsInput = PrintSettings.superRefine((value, ctx) => {
  if (value.pageSelection === 'custom' && !(value.pages ?? '').trim()) {
    ctx.addIssue({ code: 'custom', path: ['pages'], message: 'Enter the pages to print' });
  }
});
export type PrintSettingsInput = z.infer<typeof PrintSettingsInput>;

// ---- rates -------------------------------------------------------------------------------

export const MAX_PRICE_PER_SIDE_PAISE = 100_000; // ₹1000: a sanity ceiling against typos

export const RateEntry = z.object({
  paperSize: PaperSize,
  colorMode: ColorMode,
  sides: Sides,
  pricePerSidePaise: z.number().int().min(0).max(MAX_PRICE_PER_SIDE_PAISE),
});
export type RateEntry = z.infer<typeof RateEntry>;

export const RatesBody = z
  .object({
    rates: z.array(RateEntry).max(12),
    minimumChargePaise: z.number().int().min(0).max(MAX_PRICE_PER_SIDE_PAISE),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [i, r] of value.rates.entries()) {
      const key = `${r.paperSize}/${r.colorMode}/${r.sides}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['rates', i], message: `Duplicate rate for ${key}` });
      }
      seen.add(key);
    }
  });
export type RatesBody = z.infer<typeof RatesBody>;

// ---- public shop page --------------------------------------------------------------------

export const PublicShopInfo = z.object({
  slug: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  contactPhone: z.string().nullable(),
  currency: z.string(),
  rates: z.array(RateEntry),
  minimumChargePaise: z.number().int(),
  limits: z.object({
    maxUploadBytes: z.number().int(),
    maxCopies: z.number().int(),
    maxItemsPerOrder: z.number().int(),
    retentionHours: z.number(),
  }),
  /** Cloudflare Turnstile site key; absent when bot checks are disabled. */
  turnstileSiteKey: z.string().nullable(),
});
export type PublicShopInfo = z.infer<typeof PublicShopInfo>;

// ---- estimate and order creation ---------------------------------------------------------

export const MAX_ITEMS_PER_ORDER = 10;

export const OrderItemInput = z.object({
  uploadToken: z.string().regex(UPLOAD_TOKEN_PATTERN),
  settings: PrintSettingsInput,
});
export type OrderItemInput = z.infer<typeof OrderItemInput>;

export const EstimateRequest = z.object({
  items: z.array(OrderItemInput).min(1).max(MAX_ITEMS_PER_ORDER),
});
export type EstimateRequest = z.infer<typeof EstimateRequest>;

export const EstimateItem = z.object({
  uploadToken: z.string(),
  selectedPageCount: z.number().int(),
  printedSides: z.number().int(),
  sheets: z.number().int(),
  pricePerSidePaise: z.number().int(),
  amountPaise: z.number().int(),
});
export type EstimateItem = z.infer<typeof EstimateItem>;

export const EstimateResponse = z.object({
  items: z.array(EstimateItem),
  subtotalPaise: z.number().int(),
  minimumChargePaise: z.number().int(),
  minimumApplied: z.boolean(),
  totalPaise: z.number().int(),
  currency: z.string(),
  /** Always true: the shop confirms the final amount at the counter. */
  isEstimate: z.literal(true),
});
export type EstimateResponse = z.infer<typeof EstimateResponse>;

export const CreateOrderRequest = z.object({
  customerName: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => (v ? v : undefined)),
  items: z.array(OrderItemInput).min(1).max(MAX_ITEMS_PER_ORDER),
  /** Cloudflare Turnstile response token, required when the site key is configured. */
  turnstileToken: z.string().max(4096).optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

// ---- order view --------------------------------------------------------------------------

export const OrderItemView = z.object({
  originalName: z.string(),
  pageCount: z.number().int(),
  selectedPageCount: z.number().int(),
  settings: PrintSettings,
  printedSides: z.number().int(),
  sheets: z.number().int(),
  amountPaise: z.number().int(),
});
export type OrderItemView = z.infer<typeof OrderItemView>;

export const OrderView = z.object({
  /** "P014": the number the shop calls out. */
  queueNumber: z.string(),
  status: OrderStatus,
  customerName: z.string().nullable(),
  shopName: z.string(),
  items: z.array(OrderItemView),
  totalPaise: z.number().int(),
  finalAmountPaise: z.number().int().nullable(),
  currency: z.string(),
  rejectionReason: z.string().nullable(),
  /** Orders in front of this one that are still waiting. */
  aheadCount: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type OrderView = z.infer<typeof OrderView>;

export const CreateOrderResponse = z.object({
  /** Secret handle to follow the order. Shown only once; keep it in the page URL. */
  lookupToken: z.string(),
  order: OrderView,
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

export const ORDER_LOOKUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
