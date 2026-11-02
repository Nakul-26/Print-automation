import { z } from 'zod';
import { Email } from './identity.js';
import { OrderStatus } from './order.js';
import { PaymentTotals } from './owner-orders.js';
import { ShopSlug, ShopStatus } from './shops.js';

/** What a new shop owner fills in on the public sign-up page. */
export const ApplyRequest = z.object({
  shopName: z.string().trim().min(2).max(80),
  slug: ShopSlug,
  ownerName: z.string().trim().min(2).max(80),
  email: Email,
  password: z.string().min(10).max(256),
  phone: z.string().trim().min(7).max(20),
  address: z.string().trim().min(5).max(300),
  /** Cloudflare Turnstile token, when the platform has it switched on. */
  botToken: z.string().max(4096).optional(),
});
export type ApplyRequest = z.infer<typeof ApplyRequest>;

export const ApplyConfig = z.object({ turnstileSiteKey: z.string().nullable() });
export type ApplyConfig = z.infer<typeof ApplyConfig>;

export const ApplyResponse = z.object({ shopId: z.uuid(), status: ShopStatus });
export type ApplyResponse = z.infer<typeof ApplyResponse>;

/** Per-shop switches the platform admin controls. A missing key means "on". */
export const ShopFlags = z.object({ officeFiles: z.boolean() });
export type ShopFlags = z.infer<typeof ShopFlags>;

/** What a shop did over a period, for the platform admin. */
export const ShopStats = z.object({
  orders: z.number().int(),
  printed: z.number().int(),
  rejected: z.number().int(),
  pages: z.number().int(),
  /** Online money received (refunds taken off). */
  collectedPaise: z.number().int(),
  /** Printed orders paid at the counter. */
  counterCount: z.number().int(),
  counterPaise: z.number().int(),
  refundFailed: z.number().int(),
  lastOrderAt: z.string().nullable(),
});
export type ShopStats = z.infer<typeof ShopStats>;

export const AdminShop = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: ShopStatus,
  address: z.string().nullable(),
  contactPhone: z.string().nullable(),
  createdAt: z.string(),
  owner: z.object({ name: z.string(), email: z.string() }).nullable(),
  storageBytes: z.number(),
  /** Null means "use the platform default share" (no separate cap). */
  storageQuotaBytes: z.number().nullable(),
  openOrders: z.number(),
  totalOrders: z.number(),
  ratesSet: z.boolean(),
  printingPaired: z.boolean(),
  /** Is the shop's printing app connected right now? */
  printingOnline: z.boolean(),
  /** When the printing app was last active (connected or finished a job); null if never. */
  printingLastSeenAt: z.string().nullable(),
  /** The last 30 days, including today. */
  stats30: ShopStats,
  /** Online payment set-up of this shop (the keys themselves are never shown). */
  onlinePayments: z.object({
    enabled: z.boolean(),
    mode: z.enum(['test', 'live']).nullable(),
  }),
  /** The platform admin's private notes about this shop. */
  adminNotes: z.string(),
  flags: ShopFlags,
});
export type AdminShop = z.infer<typeof AdminShop>;

export const AdminShopList = z.object({ shops: z.array(AdminShop) });
export type AdminShopList = z.infer<typeof AdminShopList>;

export const SuspendBody = z.object({ reason: z.string().trim().max(300).optional() });
export type SuspendBody = z.infer<typeof SuspendBody>;

export const ShopLimitsBody = z.object({
  /** Bytes, or null to remove the cap. */
  storageQuotaBytes: z.number().int().positive().nullable().optional(),
  flags: ShopFlags.partial().optional(),
});
export type ShopLimitsBody = z.infer<typeof ShopLimitsBody>;

export const AdminSettings = z.object({
  storageMaxBytes: z.number().int().positive(),
  /** What the server was started with; used when no value has been saved. */
  defaultStorageMaxBytes: z.number().int().positive(),
  storageUsedBytes: z.number(),
});
export type AdminSettings = z.infer<typeof AdminSettings>;

export const AdminSettingsBody = z.object({
  storageMaxBytes: z
    .number()
    .int()
    .min(100 * 1024 ** 2)
    .max(10 * 1024 ** 4),
});
export type AdminSettingsBody = z.infer<typeof AdminSettingsBody>;

export const AdminAuditEntry = z.object({
  id: z.uuid(),
  at: z.string(),
  action: z.string(),
  actorType: z.string(),
  shopId: z.uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntry>;
export const AdminAuditList = z.object({ entries: z.array(AdminAuditEntry) });
export type AdminAuditList = z.infer<typeof AdminAuditList>;

export const ShopNotesBody = z.object({ notes: z.string().trim().max(2000) });
export type ShopNotesBody = z.infer<typeof ShopNotesBody>;

export const AdminDaily = z.object({
  date: z.string(),
  orders: z.number().int(),
  printed: z.number().int(),
  rejected: z.number().int(),
  pages: z.number().int(),
  collectedPaise: z.number().int(),
});
export type AdminDaily = z.infer<typeof AdminDaily>;

export const AdminRecentOrder = z.object({
  queueNumber: z.string(),
  status: OrderStatus,
  amountPaise: z.number().int(),
  /** How it was paid online (upi, card, ...); null for the counter. */
  paymentMethod: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminRecentOrder = z.infer<typeof AdminRecentOrder>;

/** One shop in depth: its numbers day by day, how it was paid, and its latest orders (no student names). */
export const AdminShopDetail = z.object({
  shop: AdminShop,
  daily: z.array(AdminDaily),
  byMethod: z.array(PaymentTotals),
  recent: z.array(AdminRecentOrder),
});
export type AdminShopDetail = z.infer<typeof AdminShopDetail>;

export const AdminAttention = z.object({
  shopId: z.uuid(),
  shopName: z.string(),
  kind: z.enum([
    'waiting_approval',
    'printing_offline',
    'refund_failed',
    'storage_near_cap',
    'no_orders',
  ]),
  detail: z.string(),
});
export type AdminAttention = z.infer<typeof AdminAttention>;

export const AdminOverview = z.object({
  shops: z.object({
    pending: z.number().int(),
    active: z.number().int(),
    suspended: z.number().int(),
  }),
  today: z.object({
    orders: z.number().int(),
    pages: z.number().int(),
    collectedPaise: z.number().int(),
  }),
  last30: z.object({
    orders: z.number().int(),
    pages: z.number().int(),
    collectedPaise: z.number().int(),
  }),
  byMethod30: z.array(PaymentTotals),
  /** Active shops with a printing app: how many checked in recently. */
  printingOnline: z.number().int(),
  printingOffline: z.number().int(),
  /** The 30-day platform total, one entry per day. */
  daily: z.array(AdminDaily),
  attention: z.array(AdminAttention),
});
export type AdminOverview = z.infer<typeof AdminOverview>;
