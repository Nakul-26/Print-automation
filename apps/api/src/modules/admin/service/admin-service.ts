import type {
  AdminAuditList,
  AdminSettings,
  AdminShop,
  ApplyRequest,
  ApplyResponse,
  ShopLimitsBody,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Settings } from '../../../platform/settings/index.js';
import type { Audit } from '../../audit/index.js';
import type { AdminShopRecord, ShopAction, ShopRecord } from '../../shops/index.js';

/** What the admin module needs from the other modules; the composition root supplies it. */
export interface AdminPorts {
  shops: {
    checkSlug: (slug: string) => Promise<string>;
    createShop: (input: {
      name: string;
      slug: string;
      address: string;
      contactPhone: string;
    }) => Promise<ShopRecord>;
    addOwner: (shopId: string, userId: string) => Promise<void>;
    listForAdmin: (status?: AdminShopRecord['status']) => Promise<AdminShopRecord[]>;
    changeStatus: (input: {
      shopId: string;
      action: ShopAction;
      actorId: string;
      reason?: string | undefined;
    }) => Promise<ShopRecord>;
    setLimits: (input: {
      shopId: string;
      storageQuotaBytes?: number | null | undefined;
      flags?: Partial<ShopRecord['flags']> | undefined;
      actorId: string;
    }) => Promise<ShopRecord>;
  };
  identity: {
    findUserByEmail: (email: string) => Promise<{ id: string } | null>;
    createUser: (input: {
      email: string;
      name: string;
      password: string;
    }) => Promise<{ id: string }>;
  };
  /** Gives a new shop its starter rate card. */
  applyStarterRates: (shopId: string) => Promise<void>;
  usage: {
    storageByShop: () => Promise<Map<string, number>>;
    storageTotal: () => Promise<number>;
    ordersByShop: () => Promise<Map<string, { open: number; total: number }>>;
    shopsWithRates: () => Promise<Set<string>>;
    shopsWithPrintingApp: () => Promise<Set<string>>;
  };
}

export function createAdminService(deps: {
  ports: AdminPorts;
  settings: Settings;
  audit: Audit;
  botVerify: (token: string | undefined, ip: string | undefined) => Promise<boolean>;
}) {
  const { ports, settings, audit } = deps;

  async function viewShops(status?: AdminShopRecord['status']): Promise<AdminShop[]> {
    const [shops, storage, orders, rates, printing] = await Promise.all([
      ports.shops.listForAdmin(status),
      ports.usage.storageByShop(),
      ports.usage.ordersByShop(),
      ports.usage.shopsWithRates(),
      ports.usage.shopsWithPrintingApp(),
    ]);
    return shops.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      status: s.status,
      address: s.address,
      contactPhone: s.contactPhone,
      createdAt: s.createdAt.toISOString(),
      owner: s.owner,
      storageBytes: storage.get(s.id) ?? 0,
      storageQuotaBytes: s.storageQuotaBytes,
      openOrders: orders.get(s.id)?.open ?? 0,
      totalOrders: orders.get(s.id)?.total ?? 0,
      ratesSet: rates.has(s.id),
      printingPaired: printing.has(s.id),
      flags: s.flags,
    }));
  }

  async function viewOne(shopId: string): Promise<AdminShop> {
    const found = (await viewShops()).find((s) => s.id === shopId);
    if (!found) throw new HttpError(404, 'Shop not found', 'not_found');
    return found;
  }

  async function getSettings(): Promise<AdminSettings> {
    return {
      storageMaxBytes: await settings.storageMaxBytes(),
      defaultStorageMaxBytes: settings.defaultStorageMaxBytes,
      storageUsedBytes: await ports.usage.storageTotal(),
    };
  }

  return {
    /** A new shop owner applies. Creates the account and a shop that waits for approval. */
    async apply(input: ApplyRequest, ip: string | undefined): Promise<ApplyResponse> {
      if (!(await deps.botVerify(input.botToken, ip))) {
        throw new HttpError(400, 'Please complete the check and try again', 'bot_check_failed');
      }
      const slug = await ports.shops.checkSlug(input.slug);
      if (await ports.identity.findUserByEmail(input.email)) {
        throw new HttpError(
          409,
          'An account with this email already exists. Sign in instead, or use another email.',
          'email_taken',
        );
      }
      const user = await ports.identity.createUser({
        email: input.email,
        name: input.ownerName,
        password: input.password,
      });
      const shop = await ports.shops.createShop({
        name: input.shopName,
        slug,
        address: input.address,
        contactPhone: input.phone,
      });
      await ports.shops.addOwner(shop.id, user.id);
      await ports.applyStarterRates(shop.id);
      await audit.record({
        actorType: 'user',
        actorId: user.id,
        shopId: shop.id,
        action: 'shop.applied',
        entity: 'shop',
        entityId: shop.id,
      });
      return { shopId: shop.id, status: shop.status };
    },

    viewShops,

    async changeStatus(input: {
      shopId: string;
      action: ShopAction;
      actorId: string;
      reason?: string | undefined;
    }): Promise<AdminShop> {
      await ports.shops.changeStatus(input);
      return viewOne(input.shopId);
    },

    async setLimits(shopId: string, body: ShopLimitsBody, actorId: string): Promise<AdminShop> {
      await ports.shops.setLimits({
        shopId,
        storageQuotaBytes: body.storageQuotaBytes,
        flags: body.flags,
        actorId,
      });
      return viewOne(shopId);
    },

    getSettings,

    async setStorageMax(bytes: number, actorId: string): Promise<AdminSettings> {
      await settings.setStorageMaxBytes(bytes, actorId);
      await audit.record({
        actorType: 'user',
        actorId,
        action: 'platform.storage_limit_changed',
        metadata: { storageMaxBytes: bytes },
      });
      return getSettings();
    },

    async recentActivity(shopId: string | undefined, limit: number): Promise<AdminAuditList> {
      const rows = await audit.recent({ ...(shopId ? { shopId } : {}), limit });
      return {
        entries: rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          action: r.action,
          actorType: r.actorType,
          shopId: r.shopId,
          metadata: r.metadata,
        })),
      };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
