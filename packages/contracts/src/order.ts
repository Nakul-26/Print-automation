import { z } from 'zod';

export const ORDER_STATUSES = [
  'draft',
  'processing',
  'pending',
  'accepted',
  'printing',
  'completed',
  'rejected',
  'failed',
  'expired',
] as const;
export const OrderStatus = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const ColorMode = z.enum(['black_white', 'color']);
export type ColorMode = z.infer<typeof ColorMode>;

export const Sides = z.enum(['single', 'double']);
export type Sides = z.infer<typeof Sides>;

export const PaperSize = z.enum(['A4', 'A3']);
export type PaperSize = z.infer<typeof PaperSize>;

export const PrintSettings = z.object({
  pageSelection: z.enum(['all', 'custom']),
  pages: z.string().max(200).optional(),
  copies: z.number().int().min(1).max(500),
  colorMode: ColorMode,
  sides: Sides,
  paperSize: PaperSize,
  pagesPerSheet: z.union([z.literal(1), z.literal(2), z.literal(4)]),
});
export type PrintSettings = z.infer<typeof PrintSettings>;
