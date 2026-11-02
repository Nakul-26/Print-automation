import type { PrintSettings } from '@print/contracts';
import type { Db } from '../../../platform/db/client.js';
import type { OrderStatus, PaymentMethod } from '../../../generated/prisma/enums.js';

export interface OrderItemRecord {
  id: string;
  orderId: string;
  shopId: string;
  uploadId: string;
  position: number;
  originalName: string;
  pageCount: number;
  printSettings: PrintSettings;
  selectedPages: number[];
  selectedPageCount: number;
  printedSides: number;
  sheets: number;
  amountPaise: number;
  sourceKey: string;
  printPdfKey: string | null;
  printPdfBytes: number | null;
  printPdfPages: number | null;
}

export interface OrderRecord {
  id: string;
  shopId: string;
  queueDate: string;
  queueNumber: number;
  lookupTokenHash: string;
  status: OrderStatus;
  customerName: string | null;
  estimatedAmountPaise: number;
  finalAmountPaise: number | null;
  currency: string;
  paymentMethod: PaymentMethod | null;
  paidAmountPaise: number | null;
  paidAt: Date | null;
  rejectionReason: string | null;
  failureReason: string | null;
  createdAt: Date;
  expiresAt: Date;
  filesPurgedAt: Date | null;
  items: OrderItemRecord[];
}

export interface NewOrderItem {
  uploadId: string;
  sourceKey: string;
  originalName: string;
  pageCount: number;
  printSettings: PrintSettings;
  selectedPages: number[];
  printedSides: number;
  sheets: number;
  amountPaise: number;
}

export interface NewOrder {
  shopId: string;
  queueDate: string;
  lookupTokenHash: string;
  customerName: string | null;
  estimatedAmountPaise: number;
  currency: string;
  rateSnapshot: unknown;
  expiresAt: Date;
  items: NewOrderItem[];
}

/** Just enough about an order to tell its shop and student that it changed. */
export interface OrderRef {
  id: string;
  shopId: string;
  lookupTokenHash: string;
}

/** A period's numbers for one shop, counted by the day the orders were placed (shop-local date). */
export interface PeriodStats {
  orders: number;
  printed: number;
  rejected: number;
  pages: number;
  collectedPaise: number;
  unpaidCount: number;
  unpaidPaise: number;
  lastOrderAt: Date | null;
}

export interface DailyStats {
  date: string;
  orders: number;
  printed: number;
  rejected: number;
  pages: number;
  collectedPaise: number;
}

export interface MethodTotals {
  method: PaymentMethod;
  count: number;
  amountPaise: number;
}

export interface Period {
  /** First queue date, inclusive (YYYY-MM-DD). */
  from: string;
  /** Last queue date, inclusive; open-ended when missing. */
  to?: string | undefined;
  /** Only this shop; every shop when missing. */
  shopId?: string | undefined;
}

export interface PrintFileUsage {
  orderId: string;
  status: OrderStatus;
  createdAt: Date;
  bytes: number;
}

/** Thrown when an upload is already part of another order. */
export class UploadAlreadyOrderedError extends Error {}

const withItems = { items: { orderBy: { position: 'asc' as const } } };

/** The only code in this module that touches the database. */
export function createOrderRepo(db: Db) {
  return {
    /**
     * Creates the order and hands out the next queue number for the shop's day in a single
     * transaction. The counter row is incremented atomically, so two students submitting at
     * the same moment can never receive the same number.
     */
    async createWithQueueNumber(input: NewOrder): Promise<OrderRecord> {
      try {
        const created = await db.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ last_number: number }[]>`
            INSERT INTO order_counters (shop_id, date_key, last_number)
            VALUES (${input.shopId}::uuid, ${input.queueDate}, 1)
            ON CONFLICT (shop_id, date_key)
            DO UPDATE SET last_number = order_counters.last_number + 1
            RETURNING last_number`;
          const queueNumber = rows[0]?.last_number;
          if (queueNumber === undefined) throw new Error('could not allocate a queue number');

          return tx.order.create({
            data: {
              shopId: input.shopId,
              queueDate: input.queueDate,
              queueNumber: Number(queueNumber),
              lookupTokenHash: input.lookupTokenHash,
              customerName: input.customerName,
              estimatedAmountPaise: input.estimatedAmountPaise,
              currency: input.currency,
              rateSnapshot: input.rateSnapshot as never,
              expiresAt: input.expiresAt,
              items: {
                create: input.items.map((item, position) => ({
                  shopId: input.shopId,
                  uploadId: item.uploadId,
                  sourceKey: item.sourceKey,
                  position,
                  originalName: item.originalName,
                  pageCount: item.pageCount,
                  printSettings: item.printSettings as never,
                  selectedPages: item.selectedPages as never,
                  selectedPageCount: item.selectedPages.length,
                  printedSides: item.printedSides,
                  sheets: item.sheets,
                  amountPaise: item.amountPaise,
                })),
              },
            },
            include: withItems,
          });
        });
        return created as unknown as OrderRecord;
      } catch (err) {
        // P2002 is a unique-constraint violation; only order_items.upload_id means "already ordered".
        const e = err as { code?: string; message?: string; meta?: { target?: unknown } };
        if (
          e?.code === 'P2002' &&
          /upload_id/.test(JSON.stringify(e.meta?.target ?? '') + (e.message ?? ''))
        ) {
          throw new UploadAlreadyOrderedError();
        }
        throw err;
      }
    },

    async findById(id: string): Promise<OrderRecord | null> {
      const row = await db.order.findUnique({ where: { id }, include: withItems });
      return row as unknown as OrderRecord | null;
    },

    async findByLookupHash(lookupTokenHash: string): Promise<OrderRecord | null> {
      const row = await db.order.findUnique({ where: { lookupTokenHash }, include: withItems });
      return row as unknown as OrderRecord | null;
    },

    /** Orders a shop still has to deal with, plus everything finished in the last day, oldest first. */
    async listForShop(shopId: string, finishedSince: Date, limit: number): Promise<OrderRecord[]> {
      const rows = await db.order.findMany({
        where: {
          shopId,
          OR: [
            { status: { in: ['pending', 'accepted', 'printing'] } },
            {
              status: { in: ['processing', 'completed', 'rejected', 'failed'] },
              updatedAt: { gte: finishedSince },
            },
          ],
        },
        include: withItems,
        orderBy: [{ queueDate: 'asc' }, { queueNumber: 'asc' }],
        take: limit,
      });
      return rows as unknown as OrderRecord[];
    },

    /** Always scoped by shop: an order id from another shop is simply not found. */
    async findForShop(shopId: string, id: string): Promise<OrderRecord | null> {
      const row = await db.order.findFirst({ where: { id, shopId }, include: withItems });
      return row as unknown as OrderRecord | null;
    },

    /**
     * Moves an order to a new status only if it is still in one of the expected states, so two
     * people clicking at once cannot both win. Returns the updated order, or null if it had moved on.
     */
    async transition(
      shopId: string,
      id: string,
      from: OrderStatus[],
      data: {
        status: OrderStatus;
        rejectionReason?: string;
        finalAmountPaise?: number;
        completedAt?: Date;
      },
    ): Promise<OrderRecord | null> {
      const { count } = await db.order.updateMany({
        where: { id, shopId, status: { in: from } },
        data,
      });
      return count === 1 ? this.findForShop(shopId, id) : null;
    },

    /** Records (or corrects) how the student paid. Only orders the shop actually dealt with can be paid. */
    async recordPayment(
      shopId: string,
      id: string,
      data: { method: PaymentMethod; amountPaise: number; at: Date },
    ): Promise<OrderRecord | null> {
      const { count } = await db.order.updateMany({
        where: { id, shopId, status: { in: ['pending', 'accepted', 'printing', 'completed'] } },
        data: { paymentMethod: data.method, paidAmountPaise: data.amountPaise, paidAt: data.at },
      });
      return count === 1 ? this.findForShop(shopId, id) : null;
    },

    /** One row of numbers per shop for the period. Shops with no orders are absent. */
    async statsByShop(period: Period): Promise<Map<string, PeriodStats>> {
      const { from, to = '9999-12-31' } = period;
      const shop = period.shopId ?? null;
      const rows = await db.$queryRaw<
        {
          shop_id: string;
          orders: bigint;
          printed: bigint;
          rejected: bigint;
          collected: bigint;
          unpaid_count: bigint;
          unpaid_paise: bigint;
          last_order_at: Date | null;
        }[]
      >`
        SELECT o.shop_id,
               count(*) AS orders,
               count(*) FILTER (WHERE o.status = 'completed') AS printed,
               count(*) FILTER (WHERE o.status = 'rejected') AS rejected,
               coalesce(sum(o.paid_amount_paise), 0) AS collected,
               count(*) FILTER (WHERE o.status = 'completed' AND o.payment_method IS NULL) AS unpaid_count,
               coalesce(sum(coalesce(o.final_amount_paise, o.estimated_amount_paise))
                 FILTER (WHERE o.status = 'completed' AND o.payment_method IS NULL), 0) AS unpaid_paise,
               max(o.created_at) AS last_order_at
        FROM orders o
        WHERE o.queue_date >= ${from} AND o.queue_date <= ${to}
          AND (${shop}::uuid IS NULL OR o.shop_id = ${shop}::uuid)
        GROUP BY o.shop_id`;
      const pages = await db.$queryRaw<{ shop_id: string; pages: bigint }[]>`
        SELECT oi.shop_id, coalesce(sum(oi.printed_sides), 0) AS pages
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'completed' AND o.queue_date >= ${from} AND o.queue_date <= ${to}
          AND (${shop}::uuid IS NULL OR o.shop_id = ${shop}::uuid)
        GROUP BY oi.shop_id`;
      const pageMap = new Map(pages.map((p) => [p.shop_id, Number(p.pages)]));
      return new Map(
        rows.map((r) => [
          r.shop_id,
          {
            orders: Number(r.orders),
            printed: Number(r.printed),
            rejected: Number(r.rejected),
            pages: pageMap.get(r.shop_id) ?? 0,
            collectedPaise: Number(r.collected),
            unpaidCount: Number(r.unpaid_count),
            unpaidPaise: Number(r.unpaid_paise),
            lastOrderAt: r.last_order_at,
          },
        ]),
      );
    },

    /** One row per day with orders (days without orders are absent), oldest first. */
    async dailyStats(period: Period): Promise<DailyStats[]> {
      const { from, to = '9999-12-31' } = period;
      const shop = period.shopId ?? null;
      const rows = await db.$queryRaw<
        {
          date: string;
          orders: bigint;
          printed: bigint;
          rejected: bigint;
          collected: bigint;
          pages: bigint;
        }[]
      >`
        SELECT o.queue_date AS date,
               count(*) AS orders,
               count(*) FILTER (WHERE o.status = 'completed') AS printed,
               count(*) FILTER (WHERE o.status = 'rejected') AS rejected,
               coalesce(sum(o.paid_amount_paise), 0) AS collected,
               coalesce(sum((SELECT sum(oi.printed_sides) FROM order_items oi WHERE oi.order_id = o.id))
                 FILTER (WHERE o.status = 'completed'), 0) AS pages
        FROM orders o
        WHERE o.queue_date >= ${from} AND o.queue_date <= ${to}
          AND (${shop}::uuid IS NULL OR o.shop_id = ${shop}::uuid)
        GROUP BY o.queue_date
        ORDER BY o.queue_date`;
      return rows.map((r) => ({
        date: r.date,
        orders: Number(r.orders),
        printed: Number(r.printed),
        rejected: Number(r.rejected),
        pages: Number(r.pages),
        collectedPaise: Number(r.collected),
      }));
    },

    /** What was collected, split by how it was paid. */
    async methodTotals(period: Period): Promise<MethodTotals[]> {
      const { from, to = '9999-12-31' } = period;
      const shop = period.shopId ?? null;
      const rows = await db.$queryRaw<{ method: PaymentMethod; count: bigint; amount: bigint }[]>`
        SELECT o.payment_method AS method, count(*) AS count,
               coalesce(sum(o.paid_amount_paise), 0) AS amount
        FROM orders o
        WHERE o.payment_method IS NOT NULL
          AND o.queue_date >= ${from} AND o.queue_date <= ${to}
          AND (${shop}::uuid IS NULL OR o.shop_id = ${shop}::uuid)
        GROUP BY o.payment_method
        ORDER BY o.payment_method`;
      return rows.map((r) => ({
        method: r.method,
        count: Number(r.count),
        amountPaise: Number(r.amount),
      }));
    },

    /** The latest orders of a shop without personal data, for the platform admin. */
    async recentForShop(
      shopId: string,
      limit: number,
    ): Promise<
      {
        queueNumber: number;
        status: OrderStatus;
        amountPaise: number;
        paymentMethod: PaymentMethod | null;
        createdAt: Date;
      }[]
    > {
      const rows = await db.order.findMany({
        where: { shopId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          queueNumber: true,
          status: true,
          estimatedAmountPaise: true,
          finalAmountPaise: true,
          paidAmountPaise: true,
          paymentMethod: true,
          createdAt: true,
        },
      });
      return rows.map((r) => ({
        queueNumber: r.queueNumber,
        status: r.status,
        amountPaise: r.paidAmountPaise ?? r.finalAmountPaise ?? r.estimatedAmountPaise,
        paymentMethod: r.paymentMethod,
        createdAt: r.createdAt,
      }));
    },

    /** Open orders past their retention time become expired. */
    async expireOpenOrders(now: Date): Promise<OrderRef[]> {
      const where = {
        status: { in: ['pending', 'accepted', 'printing'] as OrderStatus[] },
        expiresAt: { lte: now },
      };
      const refs = await db.order.findMany({
        where,
        select: { id: true, shopId: true, lookupTokenHash: true },
      });
      if (refs.length === 0) return [];
      await db.order.updateMany({
        where: { ...where, id: { in: refs.map((o) => o.id) } },
        data: { status: 'expired', failureReason: 'Files were removed after the retention period' },
      });
      return refs;
    },

    /** Orders whose files never finished preparing are failed so students are not left waiting. */
    async failStuckProcessing(createdBefore: Date): Promise<OrderRef[]> {
      const where = { status: 'processing' as OrderStatus, createdAt: { lte: createdBefore } };
      const refs = await db.order.findMany({
        where,
        select: { id: true, shopId: true, lookupTokenHash: true },
      });
      if (refs.length === 0) return [];
      await db.order.updateMany({
        where: { ...where, id: { in: refs.map((o) => o.id) } },
        data: { status: 'failed', failureReason: 'Preparing the documents took too long' },
      });
      return refs;
    },

    /** Finished orders (any ending) past their retention time that still have print files. */
    async listPurgeable(now: Date, limit: number): Promise<OrderRecord[]> {
      const rows = await db.order.findMany({
        where: {
          filesPurgedAt: null,
          expiresAt: { lte: now },
          status: { in: ['completed', 'rejected', 'failed', 'expired'] },
        },
        include: withItems,
        orderBy: { expiresAt: 'asc' },
        take: limit,
      });
      return rows as unknown as OrderRecord[];
    },

    async findManyWithItems(ids: string[]): Promise<OrderRecord[]> {
      const rows = await db.order.findMany({
        where: { id: { in: ids }, filesPurgedAt: null },
        include: withItems,
      });
      return rows as unknown as OrderRecord[];
    },

    /** Order counts per shop for the admin's usage view ("open" = still needs the shop's attention). */
    async countsByShop(): Promise<Map<string, { open: number; total: number }>> {
      const rows = await db.order.groupBy({ by: ['shopId', 'status'], _count: { _all: true } });
      const open = new Set(['pending', 'accepted', 'printing']);
      const result = new Map<string, { open: number; total: number }>();
      for (const row of rows) {
        const entry = result.get(row.shopId) ?? { open: 0, total: 0 };
        entry.total += row._count._all;
        if (open.has(row.status)) entry.open += row._count._all;
        result.set(row.shopId, entry);
      }
      return result;
    },

    /** Print-file bytes per order, for storage accounting. */
    async printFileUsage(): Promise<PrintFileUsage[]> {
      const rows = await db.order.findMany({
        where: { filesPurgedAt: null, items: { some: { printPdfKey: { not: null } } } },
        select: {
          id: true,
          status: true,
          createdAt: true,
          items: { select: { printPdfBytes: true } },
        },
      });
      return rows.map((o) => ({
        orderId: o.id,
        status: o.status,
        createdAt: o.createdAt,
        bytes: o.items.reduce((sum, i) => sum + (i.printPdfBytes ?? 0), 0),
      }));
    },

    /**
     * Records that an order's print files are gone. If the order was still open it can no longer
     * be printed, so it expires, with the reason for the shop and the student.
     */
    async markFilesPurged(ids: string[], at: Date, reasonIfOpen: string): Promise<OrderRef[]> {
      if (ids.length === 0) return [];
      const open = ['pending', 'accepted', 'printing'] as OrderStatus[];
      const refs = await db.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, shopId: true, lookupTokenHash: true },
      });
      await db.$transaction([
        db.orderItem.updateMany({
          where: { orderId: { in: ids } },
          data: { printPdfKey: null, printPdfBytes: null },
        }),
        db.order.updateMany({
          where: { id: { in: ids }, status: { in: open } },
          data: { status: 'expired', failureReason: reasonIfOpen },
        }),
        db.order.updateMany({ where: { id: { in: ids } }, data: { filesPurgedAt: at } }),
      ]);
      return refs;
    },

    /** Orders in front of this one that are still waiting to be dealt with. */
    aheadCount(order: Pick<OrderRecord, 'shopId' | 'queueDate' | 'queueNumber'>): Promise<number> {
      return db.order.count({
        where: {
          shopId: order.shopId,
          queueDate: order.queueDate,
          queueNumber: { lt: order.queueNumber },
          status: { in: ['processing', 'pending', 'accepted', 'printing'] },
        },
      });
    },

    async setItemPrintPdf(
      itemId: string,
      data: { printPdfKey: string; printPdfBytes: number; printPdfPages: number },
    ): Promise<void> {
      await db.orderItem.update({ where: { id: itemId }, data });
    },

    async markPending(id: string): Promise<boolean> {
      const { count } = await db.order.updateMany({
        where: { id, status: 'processing' },
        data: { status: 'pending' },
      });
      return count === 1;
    },

    async markFailed(id: string, failureReason: string): Promise<void> {
      await db.order.updateMany({
        where: { id, status: 'processing' },
        data: { status: 'failed', failureReason },
      });
    },
  };
}

export type OrderRepo = ReturnType<typeof createOrderRepo>;
