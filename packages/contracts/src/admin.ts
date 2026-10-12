import { z } from 'zod';
import { Email } from './identity.js';
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
