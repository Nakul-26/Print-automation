import { formatQueueNumber } from '@print/domain';
import type {
  AdminAttention,
  AdminAuditList,
  AdminDaily,
  AdminOverview,
  AdminRecentOrder,
  AdminSettings,
  AdminShop,
  AdminShopDetail,
  ApplyRequest,
  ApplyResponse,
  PaymentTotals,
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
    setAdminNotes: (input: {
      shopId: string;
      notes: string;
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
    /** Which shops take online payment (keys are never exposed). */
    onlinePayments: () => Promise<Map<string, { enabled: boolean; mode: 'test' | 'live' }>>;
    /** Live connection state and last activity of each shop's printing app. */
    printingPresence: () => Promise<Map<string, { online: boolean; lastSeenAt: Date | null }>>;
  };
  /** Orders, payments and pages over the last N days (today included). */
  activity: {
    statsByShop: (days: number) => Promise<Map<string, PeriodStats>>;
    daily: (days: number, shopId?: string) => Promise<AdminDaily[]>;
    methods: (days: number, shopId?: string) => Promise<PaymentTotals[]>;
    recent: (
      shopId: string,
      limit: number,
    ) => Promise<
      {
        queueNumber: number;
        status: AdminRecentOrder['status'];
        amountPaise: number;
        paymentMethod: AdminRecentOrder['paymentMethod'];
        createdAt: Date;
      }[]
    >;
  };
}

export interface PeriodStats {
  orders: number;
  printed: number;
  rejected: number;
  pages: number;
  collectedPaise: number;
  counterCount: number;
  counterPaise: number;
  refundFailed: number;
  lastOrderAt: Date | null;
}

const NO_STATS: PeriodStats = {
  orders: 0,
  printed: 0,
  rejected: 0,
  pages: 0,
  collectedPaise: 0,
  counterCount: 0,
  counterPaise: 0,
  refundFailed: 0,
  lastOrderAt: null,
};

const DAY_MS = 86_400_000;

export function createAdminService(deps: {
  ports: AdminPorts;
  settings: Settings;
  audit: Audit;
  botVerify: (token: string | undefined, ip: string | undefined) => Promise<boolean>;
}) {
  const { ports, settings, audit } = deps;

  async function viewShops(status?: AdminShopRecord['status']): Promise<AdminShop[]> {
    const [shops, storage, orders, rates, printing, presence, stats30, online] = await Promise.all([
      ports.shops.listForAdmin(status),
      ports.usage.storageByShop(),
      ports.usage.ordersByShop(),
      ports.usage.shopsWithRates(),
      ports.usage.shopsWithPrintingApp(),
      ports.usage.printingPresence(),
      ports.activity.statsByShop(30),
      ports.usage.onlinePayments(),
    ]);
    return shops.map((s) => {
      const stats = stats30.get(s.id) ?? NO_STATS;
      return {
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
        printingOnline: presence.get(s.id)?.online ?? false,
        printingLastSeenAt: presence.get(s.id)?.lastSeenAt?.toISOString() ?? null,
        stats30: {
          orders: stats.orders,
          printed: stats.printed,
          rejected: stats.rejected,
          pages: stats.pages,
          collectedPaise: stats.collectedPaise,
          counterCount: stats.counterCount,
          counterPaise: stats.counterPaise,
          refundFailed: stats.refundFailed,
          lastOrderAt: stats.lastOrderAt?.toISOString() ?? null,
        },
        onlinePayments: {
          enabled: online.get(s.id)?.enabled ?? false,
          mode: online.get(s.id)?.mode ?? null,
        },
        adminNotes: s.adminNotes,
        flags: s.flags,
      };
    });
  }

  /** Things the platform admin should look at today, most urgent first. */
  function attentionFor(shops: AdminShop[], now: Date): AdminAttention[] {
    const items: AdminAttention[] = [];
    for (const s of shops) {
      const add = (kind: AdminAttention['kind'], detail: string) =>
        items.push({ shopId: s.id, shopName: s.name, kind, detail });
      if (s.status === 'pending_approval') {
        const days = Math.floor((now.getTime() - Date.parse(s.createdAt)) / DAY_MS);
        add('waiting_approval', days < 1 ? 'Applied today' : `Waiting for ${days} day(s)`);
      }
      if (s.status !== 'active') continue;
      if (s.printingPaired && !s.printingOnline && s.openOrders > 0) {
        add('printing_offline', `${s.openOrders} order(s) waiting but the printing app is offline`);
      }
      if (s.stats30.refundFailed > 0) {
        add(
          'refund_failed',
          `${s.stats30.refundFailed} refund(s) did not go through and need to be sent from the shop's Razorpay dashboard`,
        );
      }
      if (s.storageQuotaBytes && s.storageBytes > s.storageQuotaBytes * 0.8) {
        add(
          'storage_near_cap',
          `Using ${Math.round((s.storageBytes / s.storageQuotaBytes) * 100)}% of its storage cap`,
        );
      }
      const ageDays = (now.getTime() - Date.parse(s.createdAt)) / DAY_MS;
      if (s.stats30.orders === 0 && ageDays > 7) add('no_orders', 'No orders in the last 30 days');
    }
    return items;
  }

  const sum = (rows: AdminDaily[]) =>
    rows.reduce(
      (t, r) => ({
        orders: t.orders + r.orders,
        pages: t.pages + r.pages,
        collectedPaise: t.collectedPaise + r.collectedPaise,
      }),
      { orders: 0, pages: 0, collectedPaise: 0 },
    );

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

    /** The platform at a glance: shops by state, today and 30-day totals, and what needs attention. */
    async overview(): Promise<AdminOverview> {
      const [shops, daily, byMethod30] = await Promise.all([
        viewShops(),
        ports.activity.daily(30),
        ports.activity.methods(30),
      ]);
      const active = shops.filter((s) => s.status === 'active');
      const withApp = active.filter((s) => s.printingPaired);
      const online = withApp.filter((s) => s.printingOnline).length;
      const today = daily[daily.length - 1];
      return {
        shops: {
          pending: shops.filter((s) => s.status === 'pending_approval').length,
          active: active.length,
          suspended: shops.filter((s) => s.status === 'suspended').length,
        },
        today: today
          ? { orders: today.orders, pages: today.pages, collectedPaise: today.collectedPaise }
          : { orders: 0, pages: 0, collectedPaise: 0 },
        last30: sum(daily),
        byMethod30,
        printingOnline: online,
        printingOffline: withApp.length - online,
        daily,
        attention: attentionFor(shops, new Date()),
      };
    },

    /** One shop in depth. Recent orders carry no student names. */
    async shopDetail(shopId: string): Promise<AdminShopDetail> {
      const shop = await viewOne(shopId);
      const [daily, byMethod, recent] = await Promise.all([
        ports.activity.daily(30, shopId),
        ports.activity.methods(30, shopId),
        ports.activity.recent(shopId, 20),
      ]);
      return {
        shop,
        daily,
        byMethod,
        recent: recent.map((r) => ({
          queueNumber: formatQueueNumber(r.queueNumber),
          status: r.status,
          amountPaise: r.amountPaise,
          paymentMethod: r.paymentMethod,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },

    async setNotes(shopId: string, notes: string, actorId: string): Promise<AdminShop> {
      await ports.shops.setAdminNotes({ shopId, notes, actorId });
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
