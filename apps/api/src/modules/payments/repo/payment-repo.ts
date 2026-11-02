import type { Db } from '../../../platform/db/client.js';
import type { OnlinePaymentStatus } from '../../../generated/prisma/enums.js';

export interface SettingsRecord {
  shopId: string;
  provider: string;
  keyId: string;
  keySecretEnc: string;
  enabled: boolean;
}

export interface PaymentRecord {
  id: string;
  orderId: string;
  shopId: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  status: OnlinePaymentStatus;
  amountPaise: number;
  currency: string;
  method: string | null;
  refundId: string | null;
  error: string | null;
  createdAt: Date;
  paidAt: Date | null;
  refundedAt: Date | null;
  updatedAt: Date;
}

/** The only code in this module that touches the database. */
export function createPaymentRepo(db: Db) {
  return {
    // ---- a shop's own gateway account
    async getSettings(shopId: string): Promise<SettingsRecord | null> {
      const row = await db.shopPaymentSettings.findUnique({ where: { shopId } });
      return row && { ...row };
    },

    async upsertSettings(data: SettingsRecord): Promise<void> {
      await db.shopPaymentSettings.upsert({
        where: { shopId: data.shopId },
        create: data,
        update: {
          provider: data.provider,
          keyId: data.keyId,
          keySecretEnc: data.keySecretEnc,
          enabled: data.enabled,
        },
      });
    },

    async setEnabled(shopId: string, enabled: boolean): Promise<boolean> {
      const { count } = await db.shopPaymentSettings.updateMany({
        where: { shopId },
        data: { enabled },
      });
      return count === 1;
    },

    async deleteSettings(shopId: string): Promise<void> {
      await db.shopPaymentSettings.deleteMany({ where: { shopId } });
    },

    /** Shops that have online payment on, and what kind of keys they use (for the platform admin). */
    async allSettings(): Promise<{ shopId: string; keyId: string; enabled: boolean }[]> {
      return db.shopPaymentSettings.findMany({
        select: { shopId: true, keyId: true, enabled: true },
      });
    },

    // ---- one online payment per order
    async createPayment(data: {
      orderId: string;
      shopId: string;
      provider: string;
      providerOrderId: string;
      amountPaise: number;
      currency: string;
    }): Promise<PaymentRecord> {
      return db.onlinePayment.create({ data });
    },

    findByOrderId(orderId: string): Promise<PaymentRecord | null> {
      return db.onlinePayment.findUnique({ where: { orderId } });
    },

    /**
     * Moves a payment to its next status only if it is still in one of the expected ones, so the
     * browser's confirmation, the background check and a refund can never step on each other.
     */
    async transition(
      id: string,
      from: OnlinePaymentStatus[],
      data: {
        status: OnlinePaymentStatus;
        providerPaymentId?: string | null;
        method?: string | null;
        refundId?: string | null;
        error?: string | null;
        paidAt?: Date;
        refundedAt?: Date;
      },
    ): Promise<PaymentRecord | null> {
      const { count } = await db.onlinePayment.updateMany({
        where: { id, status: { in: from } },
        data,
      });
      return count === 1 ? db.onlinePayment.findUnique({ where: { id } }) : null;
    },

    listByStatus(status: OnlinePaymentStatus, limit: number): Promise<PaymentRecord[]> {
      return db.onlinePayment.findMany({
        where: { status },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
    },

    /** Payments given up on recently: a late payer may still turn up, and must get their money back. */
    listAbandonedSince(since: Date, limit: number): Promise<PaymentRecord[]> {
      return db.onlinePayment.findMany({
        where: { status: 'abandoned', updatedAt: { gte: since } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      });
    },

    /** Payments of a shop that are still moving: changing its keys now would strand them. */
    countInFlight(shopId: string): Promise<number> {
      return db.onlinePayment.count({
        where: { shopId, status: { in: ['awaiting', 'refund_pending'] } },
      });
    },
  };
}

export type PaymentRepo = ReturnType<typeof createPaymentRepo>;
