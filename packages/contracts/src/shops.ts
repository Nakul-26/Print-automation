import { z } from 'zod';

export const ShopStatus = z.enum(['pending_approval', 'active', 'suspended']);
export type ShopStatus = z.infer<typeof ShopStatus>;

export const ShopRole = z.enum(['owner', 'staff']);
export type ShopRole = z.infer<typeof ShopRole>;

export const SHOP_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ShopSlug = z.string().min(3).max(48).regex(SHOP_SLUG_PATTERN);

export const ShopSummary = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: ShopStatus,
  role: ShopRole,
});
export type ShopSummary = z.infer<typeof ShopSummary>;

export const ShopDetail = ShopSummary.extend({
  address: z.string().nullable(),
  contactPhone: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
});
export type ShopDetail = z.infer<typeof ShopDetail>;

export const ShopListResponse = z.object({ shops: z.array(ShopSummary) });
export type ShopListResponse = z.infer<typeof ShopListResponse>;
