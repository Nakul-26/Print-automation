import type { Db } from '../../../platform/db/client.js';
import type { ShopRole, ShopStatus } from '../../../platform/db/enums.js';

export interface ShopRecord {
  id: string;
  slug: string;
  name: string;
  status: ShopStatus;
  address: string | null;
  contactPhone: string | null;
  timezone: string;
  currency: string;
}

export interface MembershipRecord {
  role: ShopRole;
  shop: ShopRecord;
}

const shopSelect = {
  id: true,
  slug: true,
  name: true,
  status: true,
  address: true,
  contactPhone: true,
  timezone: true,
  currency: true,
} as const;

/** The only code in this module that touches the database. */
export function createShopRepo(db: Db) {
  return {
    createShop(data: { slug: string; name: string; status: ShopStatus }): Promise<ShopRecord> {
      return db.shop.create({ data, select: shopSelect });
    },

    findById(id: string): Promise<ShopRecord | null> {
      return db.shop.findUnique({ where: { id }, select: shopSelect });
    },

    findBySlug(slug: string): Promise<ShopRecord | null> {
      return db.shop.findUnique({ where: { slug }, select: shopSelect });
    },

    async addMember(shopId: string, userId: string, role: ShopRole): Promise<void> {
      await db.shopMember.upsert({
        where: { shopId_userId: { shopId, userId } },
        create: { shopId, userId, role },
        update: { role },
      });
    },

    /** Every shop the user belongs to, with their role. */
    listMembershipsForUser(userId: string): Promise<MembershipRecord[]> {
      return db.shopMember.findMany({
        where: { userId },
        select: { role: true, shop: { select: shopSelect } },
        orderBy: { createdAt: 'asc' },
      });
    },

    /** The membership linking this user to this shop, or null if they are not a member. */
    findMembership(shopId: string, userId: string): Promise<MembershipRecord | null> {
      return db.shopMember.findUnique({
        where: { shopId_userId: { shopId, userId } },
        select: { role: true, shop: { select: shopSelect } },
      });
    },
  };
}

export type ShopRepo = ReturnType<typeof createShopRepo>;
