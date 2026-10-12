import type { PrintSettings } from '@print/contracts';
import type { Db } from '../../../platform/db/client.js';
import type { OrderStatus } from '../../../generated/prisma/enums.js';

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
