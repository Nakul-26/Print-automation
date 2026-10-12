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
  createdAt: Date;
  /** Cap on this shop's stored files in bytes; null = no separate cap. */
  storageQuotaBytes: number | null;
  /** Platform-admin switches; a missing key means "on". */
  flags: { officeFiles: boolean };
}

export interface AdminShopRecord extends ShopRecord {
  owner: { name: string; email: string } | null;
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
  createdAt: true,
  storageQuotaBytes: true,
  settings: true,
} as const;

interface ShopRow extends Omit<ShopRecord, 'storageQuotaBytes' | 'flags'> {
  storageQuotaBytes: bigint | null;
  settings: unknown;
}

function flagsOf(settings: unknown): ShopRecord['flags'] {
  const flags = (settings as { flags?: { officeFiles?: unknown } } | null)?.flags;
  return { officeFiles: flags?.officeFiles !== false };
}

function toShop(row: ShopRow): ShopRecord {
  const { storageQuotaBytes, settings, ...rest } = row;
  return {
    ...rest,
    storageQuotaBytes: storageQuotaBytes === null ? null : Number(storageQuotaBytes),
    flags: flagsOf(settings),
  };
}

/** The only code in this module that touches the database. */
export function createShopRepo(db: Db) {
  return {
    async createShop(data: {
      slug: string;
      name: string;
      status: ShopStatus;
      address?: string;
      contactPhone?: string;
    }): Promise<ShopRecord> {
      return toShop(await db.shop.create({ data, select: shopSelect }));
    },

    async findById(id: string): Promise<ShopRecord | null> {
      const row = await db.shop.findUnique({ where: { id }, select: shopSelect });
      return row && toShop(row);
    },

    async findBySlug(slug: string): Promise<ShopRecord | null> {
      const row = await db.shop.findUnique({ where: { slug }, select: shopSelect });
      return row && toShop(row);
    },

    /** Every shop (newest first) with its owner, for the platform admin. */
    async listForAdmin(status?: ShopStatus): Promise<AdminShopRecord[]> {
      const rows = await db.shop.findMany({
        ...(status ? { where: { status } } : {}),
        orderBy: { createdAt: 'desc' },
        select: {
          ...shopSelect,
          members: {
            where: { role: 'owner' },
            take: 1,
            orderBy: { createdAt: 'asc' },
            select: { user: { select: { name: true, email: true } } },
          },
        },
      });
      return rows.map(({ members, ...row }) => ({
        ...toShop(row),
        owner: members[0]?.user ?? null,
      }));
    },

    async setStatus(id: string, status: ShopStatus): Promise<ShopRecord | null> {
      const { count } = await db.shop.updateMany({ where: { id }, data: { status } });
      if (count === 0) return null;
      const row = await db.shop.findUnique({ where: { id }, select: shopSelect });
      return row && toShop(row);
    },

    /** Changes the cap and/or flags; only the fields that are given are touched. */
    async setLimits(
      id: string,
      limits: { storageQuotaBytes?: number | null; flags?: Partial<ShopRecord['flags']> },
    ): Promise<ShopRecord | null> {
      const current = await db.shop.findUnique({ where: { id }, select: { settings: true } });
      if (!current) return null;
      const settings = {
        ...((current.settings as object | null) ?? {}),
        ...(limits.flags ? { flags: { ...flagsOf(current.settings), ...limits.flags } } : {}),
      };
      const row = await db.shop.update({
        where: { id },
        select: shopSelect,
        data: {
          settings: settings as never,
          ...(limits.storageQuotaBytes !== undefined
            ? {
                storageQuotaBytes:
                  limits.storageQuotaBytes === null ? null : BigInt(limits.storageQuotaBytes),
              }
            : {}),
        },
      });
      return toShop(row);
    },

    async addMember(shopId: string, userId: string, role: ShopRole): Promise<void> {
      await db.shopMember.upsert({
        where: { shopId_userId: { shopId, userId } },
        create: { shopId, userId, role },
        update: { role },
      });
    },

    /** Every shop the user belongs to, with their role. */
    async listMembershipsForUser(userId: string): Promise<MembershipRecord[]> {
      const rows = await db.shopMember.findMany({
        where: { userId },
        select: { role: true, shop: { select: shopSelect } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({ role: r.role, shop: toShop(r.shop) }));
    },

    /** The membership linking this user to this shop, or null if they are not a member. */
    async findMembership(shopId: string, userId: string): Promise<MembershipRecord | null> {
      const row = await db.shopMember.findUnique({
        where: { shopId_userId: { shopId, userId } },
        select: { role: true, shop: { select: shopSelect } },
      });
      return row && { role: row.role, shop: toShop(row.shop) };
    },
  };
}

export type ShopRepo = ReturnType<typeof createShopRepo>;
