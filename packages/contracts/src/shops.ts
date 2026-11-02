import { z } from 'zod';
import { Email } from './identity.js';

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

/** One person who can sign in to a shop's queue. */
export const StaffMember = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: ShopRole,
  /** When they were added to the shop. */
  since: z.string(),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const StaffListResponse = z.object({ members: z.array(StaffMember) });
export type StaffListResponse = z.infer<typeof StaffListResponse>;

export const AddStaffBody = z.object({
  name: z.string().trim().min(2).max(80),
  email: Email,
});
export type AddStaffBody = z.infer<typeof AddStaffBody>;

export const AddStaffResponse = z.object({
  member: StaffMember,
  /** The first password, shown once. Null when the person already had an account. */
  password: z.string().nullable(),
  existingAccount: z.boolean(),
});
export type AddStaffResponse = z.infer<typeof AddStaffResponse>;

export const ResetStaffPasswordResponse = z.object({ password: z.string() });
export type ResetStaffPasswordResponse = z.infer<typeof ResetStaffPasswordResponse>;
