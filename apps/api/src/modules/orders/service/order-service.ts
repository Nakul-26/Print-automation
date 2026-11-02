import { createHmac, randomBytes } from 'node:crypto';
import {
  type CreateOrderRequest,
  type EstimateItem,
  type EstimateRequest,
  type EstimateResponse,
  type CheckoutPayload,
  MIN_ONLINE_PAYMENT_PAISE,
  type OrderActionBody,
  type OrderItemInput,
  type OrderPrintState,
  type OrderView,
  type OwnerOrder,
  type OwnerSummary,
  type PublicShopInfo,
} from '@print/contracts';
import {
  canTransition,
  formatQueueNumber,
  parsePageRanges,
  priceItem,
  priceOrder,
  type RateTable,
} from '@print/domain';
import { GateFullError, type Gate } from '../../../platform/capacity/index.js';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { BotCheck } from '../../../platform/http/turnstile.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { JobQueue } from '../../../platform/queue/index.js';
import type { Realtime } from '../../../platform/realtime/index.js';
import type { StorageDriver } from '../../../platform/storage/index.js';
import { REALTIME } from '@print/contracts';
import type { Audit } from '../../audit/index.js';
import type { Conversion } from '../../conversion/index.js';
import type { UsableUpload } from '../../documents/index.js';
import type { SubmitOrderInput } from '../../printing/index.js';
import { UploadAlreadyOrderedError, type OrderRecord, type OrderRepo } from '../repo/order-repo.js';

export const PREPARE_ORDER_JOB = 'order.prepare';

export interface ShopInfo {
  id: string;
  slug: string;
  name: string;
  status: 'pending_approval' | 'active' | 'suspended';
  address: string | null;
  contactPhone: string | null;
  timezone: string;
  currency: string;
}

/** What orders needs from the printing module (wired in the composition root). */
export interface PrintingPort {
  /** Queues the order's documents for the shop's printing app; 'manual' if there is none. */
  submitOrder(input: SubmitOrderInput): Promise<'agent' | 'manual'>;
  retryOrder(shopId: string, orderId: string): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  statesFor(shopId: string, orderIds: string[]): Promise<Map<string, OrderPrintState>>;
}

/** What orders needs from the payments module (wired in the composition root). */
export interface PaymentsPort {
  /** True when the shop has online payment switched on. */
  isEnabled(shopId: string): Promise<boolean>;
  /** Opens a payment with the shop's own gateway account. Nothing is stored yet. */
  prepare(input: {
    shopId: string;
    shopName: string;
    amountPaise: number;
    currency: string;
    receipt: string;
    prefillName: string | null;
  }): Promise<CheckoutPayload>;
  /** Stores the payment against the order once the order exists. */
  attach(input: { orderId: string; shopId: string; checkout: CheckoutPayload }): Promise<void>;
  /** Gives the student their money back for an order that ended without being printed. Safe to repeat. */
  requestRefund(orderId: string): Promise<void>;
}

export interface OrderServiceDeps {
  repo: OrderRepo;
  storage: StorageDriver;
  queue: JobQueue;
  conversion: Conversion;
  audit: Audit;
  logger: Logger;
  botCheck: BotCheck;
  realtime: Realtime;
  printing: PrintingPort;
  payments: PaymentsPort;
  findShopBySlug: (slug: string) => Promise<ShopInfo | null>;
  findShopById: (id: string) => Promise<ShopInfo | null>;
  getRateTable: (shopId: string) => Promise<RateTable>;
  uploads: {
    findUsableForShop(token: string, shopId: string): Promise<UsableUpload>;
    readNormalized(normalizedKey: string): Promise<Buffer>;
    extendExpiry(uploadIds: string[], expiresAt: Date): Promise<void>;
  };
  /** Limits how many print previews are built at once; extra requests wait or are turned away. */
  previewGate: Gate;
  tokenSecret: string;
  retentionHours: number;
  maxCopies: number;
  maxUploadBytes: number;
  now?: () => Date;
}

interface ResolvedItem {
  input: OrderItemInput;
  upload: UsableUpload;
  selectedPages: number[];
  printedSides: number;
  sheets: number;
  pricePerSidePaise: number;
  amountPaise: number;
}

/** The queue date (YYYY-MM-DD) in the shop's own timezone. */
export function queueDateFor(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Shops all run on Indian time today; platform-wide windows are cut on this timezone. */
const PLATFORM_TIMEZONE = 'Asia/Kolkata';

export function createOrderService(deps: OrderServiceDeps) {
  const { repo, storage, queue, conversion, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** The queue date `days - 1` days before today: the first day of a "last N days" window. */
  const daysAgo = (days: number): string =>
    queueDateFor(new Date(now().getTime() - (days - 1) * 86_400_000), PLATFORM_TIMEZONE);

  const hashToken = (token: string): string =>
    createHmac('sha256', deps.tokenSecret).update(token).digest('hex');

  async function activeShop(slug: string): Promise<ShopInfo> {
    const shop = await deps.findShopBySlug(slug);
    if (!shop || shop.status !== 'active') throw new HttpError(404, 'Shop not found', 'not_found');
    return shop;
  }

  /** Validates every item against its upload and the shop's prices. Nothing is trusted from the client. */
  async function resolveItems(
    shop: ShopInfo,
    items: OrderItemInput[],
    table: RateTable,
  ): Promise<ResolvedItem[]> {
    if (new Set(items.map((i) => i.uploadToken)).size !== items.length) {
      throw new HttpError(400, 'The same file was added twice', 'duplicate_item');
    }

    const resolved: ResolvedItem[] = [];
    for (const input of items) {
      const { settings } = input;
      if (settings.copies > deps.maxCopies) {
        throw new HttpError(
          400,
          `You can print at most ${deps.maxCopies} copies`,
          'too_many_copies',
        );
      }

      const upload = await deps.uploads.findUsableForShop(input.uploadToken, shop.id);

      let selectedPages: number[];
      if (settings.pageSelection === 'custom') {
        const parsed = parsePageRanges(settings.pages ?? '', upload.pageCount);
        if (!parsed.ok) {
          throw new HttpError(400, `${upload.originalName}: ${parsed.error}`, 'invalid_pages');
        }
        selectedPages = parsed.pages;
      } else {
        selectedPages = Array.from({ length: upload.pageCount }, (_, i) => i + 1);
      }

      const price = priceItem(
        {
          selectedPageCount: selectedPages.length,
          copies: settings.copies,
          colorMode: settings.colorMode,
          sides: settings.sides,
          paperSize: settings.paperSize,
          pagesPerSheet: settings.pagesPerSheet,
        },
        table,
      );
      if (!price.ok) {
        throw new HttpError(
          422,
          price.error === 'rate_unavailable'
            ? `This shop does not offer ${settings.paperSize} ${
                settings.colorMode === 'color' ? 'colour' : 'black & white'
              } ${settings.sides === 'double' ? 'double' : 'single'}-sided printing`
            : 'Those print settings are not valid',
          price.error,
        );
      }

      resolved.push({
        input,
        upload,
        selectedPages,
        printedSides: price.printedSides,
        sheets: price.sheets,
        pricePerSidePaise: price.pricePerSidePaise,
        amountPaise: price.amountPaise,
      });
    }
    return resolved;
  }

  /** Tells the shop's dashboards and the student's ticket that something changed. They refetch over HTTP. */
  function announce(order: Pick<OrderRecord, 'shopId' | 'lookupTokenHash'>): void {
    deps.realtime.emit(`shop:${order.shopId}`, REALTIME.queueChanged);
    deps.realtime.emit(`order:${order.lookupTokenHash}`, REALTIME.orderChanged);
  }

  function paymentContext(order: OrderRecord) {
    return {
      orderId: order.id,
      shopId: order.shopId,
      queueNumber: order.queueNumber,
      status: order.status,
      paymentState: order.paymentState,
      amountPaise: order.estimatedAmountPaise,
      currency: order.currency,
      customerName: order.customerName,
      createdAt: order.createdAt,
    };
  }

  /** Orders that ended without being printed give a paid student their money back. */
  async function refundIfPaid(orders: { id: string; paymentState: string }[]): Promise<void> {
    for (const order of orders) {
      if (order.paymentState !== 'paid') continue;
      await deps.payments.requestRefund(order.id).catch((err) => {
        logger.error({ err, orderId: order.id }, 'could not start a refund');
      });
    }
  }

  function toOwnerView(order: OrderRecord, print: OrderPrintState | null = null): OwnerOrder {
    return {
      id: order.id,
      queueNumber: formatQueueNumber(order.queueNumber),
      status: order.status as OwnerOrder['status'],
      customerName: order.customerName,
      items: order.items.map((item) => ({
        id: item.id,
        originalName: item.originalName,
        pageCount: item.pageCount,
        selectedPageCount: item.selectedPageCount,
        settings: item.printSettings,
        printedSides: item.printedSides,
        sheets: item.sheets,
        amountPaise: item.amountPaise,
        fileReady: item.printPdfKey !== null,
      })),
      estimatedAmountPaise: order.estimatedAmountPaise,
      finalAmountPaise: order.finalAmountPaise,
      currency: order.currency,
      payment:
        order.paymentState === 'paid' ||
        order.paymentState === 'refunded' ||
        order.paymentState === 'refund_failed'
          ? {
              state: order.paymentState,
              method: order.paymentMethod,
              amountPaise: order.paidAmountPaise ?? 0,
              paidAt: order.paidAt?.toISOString() ?? null,
            }
          : null,
      print,
      rejectionReason: order.rejectionReason,
      failureReason: order.failureReason,
      createdAt: order.createdAt.toISOString(),
      expiresAt: order.expiresAt.toISOString(),
    };
  }

  function toView(order: OrderRecord, shopName: string, aheadCount: number): OrderView {
    return {
      queueNumber: formatQueueNumber(order.queueNumber),
      status: order.status as OrderView['status'],
      customerName: order.customerName,
      shopName,
      items: order.items.map((item) => ({
        originalName: item.originalName,
        pageCount: item.pageCount,
        selectedPageCount: item.selectedPageCount,
        settings: item.printSettings,
        printedSides: item.printedSides,
        sheets: item.sheets,
        amountPaise: item.amountPaise,
      })),
      totalPaise: order.estimatedAmountPaise,
      finalAmountPaise: order.finalAmountPaise,
      currency: order.currency,
      payment: {
        state: order.paymentState,
        amountPaise: order.paidAmountPaise ?? order.estimatedAmountPaise,
        method: order.paymentMethod,
      },
      rejectionReason: order.rejectionReason,
      aheadCount,
      createdAt: order.createdAt.toISOString(),
      expiresAt: order.expiresAt.toISOString(),
    };
  }

  return {
    /** The public storefront data for a shop: who they are, what they charge, and the limits. */
    async getPublicInfo(slug: string): Promise<PublicShopInfo> {
      const shop = await activeShop(slug);
      const table = await deps.getRateTable(shop.id);
      return {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        contactPhone: shop.contactPhone,
        currency: shop.currency,
        rates: [...table.rates],
        minimumChargePaise: table.minimumChargePaise,
        limits: {
          maxUploadBytes: deps.maxUploadBytes,
          maxCopies: deps.maxCopies,
          maxItemsPerOrder: 10,
          retentionHours: deps.retentionHours,
        },
        onlinePayments: await deps.payments.isEnabled(shop.id),
        turnstileSiteKey: deps.botCheck.siteKey,
      };
    },

    async estimate(slug: string, request: EstimateRequest): Promise<EstimateResponse> {
      const shop = await activeShop(slug);
      const table = await deps.getRateTable(shop.id);
      const resolved = await resolveItems(shop, request.items, table);
      const total = priceOrder(
        resolved.map((r) => r.amountPaise),
        table.minimumChargePaise,
      );
      const items: EstimateItem[] = resolved.map((r) => ({
        uploadToken: r.input.uploadToken,
        selectedPageCount: r.selectedPages.length,
        printedSides: r.printedSides,
        sheets: r.sheets,
        pricePerSidePaise: r.pricePerSidePaise,
        amountPaise: r.amountPaise,
      }));
      return {
        items,
        subtotalPaise: total.subtotalPaise,
        minimumChargePaise: total.minimumChargePaise,
        minimumApplied: total.minimumApplied,
        totalPaise: total.totalPaise,
        currency: shop.currency,
        isEstimate: true,
      };
    },

    /**
     * The exact PDF that would be printed for these settings (selected pages, pages per sheet,
     * grayscale), so the student sees what the shop will print. Nothing is stored.
     */
    async previewPrint(slug: string, input: OrderItemInput): Promise<Buffer> {
      const shop = await activeShop(slug);
      const upload = await deps.uploads.findUsableForShop(input.uploadToken, shop.id);
      const { settings } = input;

      let pages: number[] | undefined;
      if (settings.pageSelection === 'custom') {
        const parsed = parsePageRanges(settings.pages ?? '', upload.pageCount);
        if (!parsed.ok) {
          throw new HttpError(400, `${upload.originalName}: ${parsed.error}`, 'invalid_pages');
        }
        pages = parsed.pages.length === upload.pageCount ? undefined : parsed.pages;
      }
      try {
        return await deps.previewGate.run(async () => {
          const source = await deps.uploads.readNormalized(upload.normalizedKey);
          return conversion.buildPrintPdf({
            source,
            ...(pages ? { pages } : {}),
            colorMode: settings.colorMode,
            pagesPerSheet: settings.pagesPerSheet,
            paperSize: settings.paperSize,
          });
        });
      } catch (err) {
        if (err instanceof GateFullError) {
          throw new HttpError(503, 'The preview is busy, trying again in a moment.', 'busy', {
            'Retry-After': '3',
          });
        }
        throw err;
      }
    },

    async create(
      slug: string,
      request: CreateOrderRequest,
      meta: { ip?: string | undefined },
    ): Promise<{ lookupToken: string; order: OrderView; checkout: CheckoutPayload | null }> {
      const shop = await activeShop(slug);

      if (!(await deps.botCheck.verify(request.turnstileToken, meta.ip))) {
        throw new HttpError(
          403,
          'Could not verify that you are not a robot. Please try again.',
          'bot_check_failed',
        );
      }

      const table = await deps.getRateTable(shop.id);
      const resolved = await resolveItems(shop, request.items, table);
      const total = priceOrder(
        resolved.map((r) => r.amountPaise),
        table.minimumChargePaise,
      );

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + deps.retentionHours * 3_600_000);
      const lookupToken = randomBytes(24).toString('base64url');

      // Online payment is opened with the shop's gateway first, so a failure leaves nothing behind.
      let checkout: CheckoutPayload | null = null;
      if (request.payment === 'online') {
        if (
          total.totalPaise < MIN_ONLINE_PAYMENT_PAISE ||
          !(await deps.payments.isEnabled(shop.id))
        ) {
          throw new HttpError(
            409,
            'Online payment is not available for this order. Choose to pay at the counter.',
            'online_payment_unavailable',
          );
        }
        checkout = await deps.payments.prepare({
          shopId: shop.id,
          shopName: shop.name,
          amountPaise: total.totalPaise,
          currency: shop.currency,
          receipt: `ord-${lookupToken.slice(0, 12)}`,
          prefillName: request.customerName ?? null,
        });
      }

      let order: OrderRecord;
      try {
        order = await repo.createWithQueueNumber({
          shopId: shop.id,
          queueDate: queueDateFor(createdAt, shop.timezone),
          lookupTokenHash: hashToken(lookupToken),
          customerName: request.customerName ?? null,
          estimatedAmountPaise: total.totalPaise,
          currency: shop.currency,
          rateSnapshot: table,
          expiresAt,
          ...(checkout ? { paymentState: 'awaiting' as const } : {}),
          items: resolved.map((r) => ({
            uploadId: r.upload.id,
            sourceKey: r.upload.normalizedKey,
            originalName: r.upload.originalName,
            pageCount: r.upload.pageCount,
            printSettings: r.input.settings,
            selectedPages: r.selectedPages,
            printedSides: r.printedSides,
            sheets: r.sheets,
            amountPaise: r.amountPaise,
          })),
        });
      } catch (err) {
        if (err instanceof UploadAlreadyOrderedError) {
          throw new HttpError(
            409,
            'One of these files is already part of another order',
            'upload_already_ordered',
          );
        }
        throw err;
      }

      // The files now live as long as the order does.
      await deps.uploads.extendExpiry(
        resolved.map((r) => r.upload.id),
        expiresAt,
      );
      await queue.enqueue(PREPARE_ORDER_JOB, { orderId: order.id });
      if (checkout) {
        try {
          await deps.payments.attach({ orderId: order.id, shopId: shop.id, checkout });
        } catch (err) {
          // Could not record the payment: fall back to paying at the counter rather than losing the order.
          logger.error({ err, orderId: order.id }, 'could not attach the online payment');
          const fallback = await repo.setPaymentState(order.id, ['awaiting'], { state: 'none' });
          if (fallback) order = fallback;
          checkout = null;
        }
      }
      await audit.record({
        actorType: 'anonymous',
        shopId: shop.id,
        action: 'order.created',
        entity: 'order',
        entityId: order.id,
        metadata: {
          queueNumber: order.queueNumber,
          totalPaise: total.totalPaise,
          items: resolved.length,
          payment: checkout ? 'online' : 'counter',
        },
      });

      announce(order);
      return {
        lookupToken,
        order: toView(order, shop.name, await repo.aheadCount(order)),
        checkout,
      };
    },

    async getByToken(token: string): Promise<OrderView> {
      const order = await repo.findByLookupHash(hashToken(token));
      if (!order) throw new HttpError(404, 'Order not found', 'not_found');
      const shop = await deps.findShopById(order.shopId);
      return toView(order, shop?.name ?? '', await repo.aheadCount(order));
    },

    /**
     * Retention, run by a schedule: open orders past their time expire, stuck orders fail, and
     * the print files of every finished order past its time are deleted.
     */
    async retire(at: Date, stuckAfterMinutes: number) {
      const expired = await repo.expireOpenOrders(at);
      const failed = await repo.failStuckProcessing(
        new Date(at.getTime() - stuckAfterMinutes * 60_000),
      );
      [...expired, ...failed].forEach(announce);
      await refundIfPaid([...expired, ...failed]);

      let purgedOrders = 0;
      let bytes = 0;
      for (;;) {
        const batch = await repo.listPurgeable(at, 100);
        if (batch.length === 0) break;
        for (const order of batch) {
          for (const item of order.items) {
            if (item.printPdfKey) await storage.delete(item.printPdfKey);
            bytes += item.printPdfBytes ?? 0;
          }
        }
        await repo.markFilesPurged(
          batch.map((o) => o.id),
          at,
          'Files were removed after the retention period',
        );
        purgedOrders += batch.length;
        if (batch.length < 100) break;
      }
      return { expired: expired.length, failed: failed.length, purgedOrders, bytes };
    },

    /**
     * What the payments module needs to know and change about an order. Every change is conditional
     * on the payment still being in the expected state, so a late or repeated message does nothing.
     */
    paymentSync: {
      async contextByToken(token: string) {
        const order = await repo.findByLookupHash(hashToken(token));
        return order ? paymentContext(order) : null;
      },
      async contextById(orderId: string) {
        const order = await repo.findById(orderId);
        return order ? paymentContext(order) : null;
      },
      /** The money arrived: the order becomes visible to the shop. */
      async markPaid(
        orderId: string,
        paid: { method: string | null; amountPaise: number; at: Date },
      ): Promise<boolean> {
        const updated = await repo.setPaymentState(orderId, ['awaiting'], {
          state: 'paid',
          method: paid.method,
          paidAmountPaise: paid.amountPaise,
          paidAt: paid.at,
        });
        if (!updated) return false;
        announce(updated);
        return true;
      },
      /** The student chose to pay at the counter instead. */
      async switchToCounter(orderId: string): Promise<boolean> {
        const updated = await repo.setPaymentState(orderId, ['awaiting'], { state: 'none' });
        if (!updated) return false;
        announce(updated);
        return true;
      },
      /** The payment never arrived in time, so the order is closed. */
      async expireUnpaid(orderId: string): Promise<boolean> {
        const updated = await repo.expireUnpaid(orderId, 'Payment was not completed in time');
        if (!updated) return false;
        announce(updated);
        return true;
      },
      /** The outcome of a refund. A refund that could not be made stays visible to the shop. */
      async recordRefund(orderId: string, outcome: 'refunded' | 'refund_failed'): Promise<boolean> {
        const updated = await repo.setPaymentState(orderId, ['paid', 'refund_failed'], {
          state: outcome,
        });
        if (!updated) return false;
        announce(updated);
        return true;
      },
    },

    /** Storage accounting for the print files the orders module holds. */
    printFileUsage: () => repo.printFileUsage(),
    countsByShop: () => repo.countsByShop(),

    /**
     * Numbers for the platform admin over the last `days` days (today included), counted by the
     * queue date. The platform runs on one timezone for now, so the cut-off uses it.
     */
    activity: {
      statsByShop: (days: number) => repo.statsByShop({ from: daysAgo(days) }),
      daily: async (days: number, shopId?: string) => {
        const rows = await repo.dailyStats({ from: daysAgo(days), shopId });
        const byDate = new Map(rows.map((r) => [r.date, r]));
        return Array.from({ length: days }, (_, i) => {
          const date = queueDateFor(
            new Date(now().getTime() - (days - 1 - i) * 86_400_000),
            PLATFORM_TIMEZONE,
          );
          return (
            byDate.get(date) ?? {
              date,
              orders: 0,
              printed: 0,
              rejected: 0,
              pages: 0,
              collectedPaise: 0,
            }
          );
        });
      },
      methods: (days: number, shopId?: string) =>
        repo.methodTotals({ from: daysAgo(days), shopId }),
      recent: (shopId: string, limit: number) => repo.recentForShop(shopId, limit),
    },

    /** Storage pressure: deletes the print files of these orders; open ones expire. */
    async evictFiles(orderIds: string[], reason: string) {
      const orders = await repo.findManyWithItems(orderIds);
      let bytes = 0;
      for (const order of orders) {
        for (const item of order.items) {
          if (item.printPdfKey) await storage.delete(item.printPdfKey);
          bytes += item.printPdfBytes ?? 0;
        }
      }
      const refs = await repo.markFilesPurged(
        orders.map((o) => o.id),
        now(),
        reason,
      );
      refs.forEach(announce);
      await refundIfPaid(refs.filter((r) => r.becameExpired));
      return { count: orders.length, bytes };
    },

    /** The shop's working list: what is waiting, being printed, or finished in the last day. */
    async listQueue(shopId: string): Promise<OwnerOrder[]> {
      const since = new Date(now().getTime() - 24 * 3_600_000);
      const orders = await repo.listForShop(shopId, since, 200);
      const printing = await deps.printing.statesFor(
        shopId,
        orders.filter((o) => o.status === 'printing' || o.status === 'completed').map((o) => o.id),
      );
      return orders.map((o) => toOwnerView(o, printing.get(o.id) ?? null));
    },

    /** Applies one of the owner's actions. The shop id comes from the authenticated tenant, never the URL alone. */
    async act(
      tenant: { shopId: string; userId: string },
      orderId: string,
      body: OrderActionBody,
    ): Promise<OwnerOrder> {
      const order = await repo.findForShop(tenant.shopId, orderId);
      if (!order) throw new HttpError(404, 'Order not found', 'not_found');

      if (body.action === 'retry_print' || body.action === 'print_manually') {
        return this.adjustPrinting(tenant, order, body.action);
      }
      if (order.paymentState === 'awaiting') {
        throw new HttpError(
          409,
          'This order is still waiting for its online payment.',
          'awaiting_payment',
        );
      }

      const target = { print: 'printing', reject: 'rejected', complete: 'completed' }[
        body.action
      ] as OrderRecord['status'];
      if (!canTransition(order.status, target)) {
        throw new HttpError(
          409,
          'This order has already moved on. The list has been refreshed.',
          'invalid_transition',
        );
      }
      const from = (['pending', 'accepted', 'printing'] as const).filter((s) =>
        canTransition(s, target),
      );

      const updated = await repo.transition(tenant.shopId, orderId, from, {
        status: target,
        ...(body.action === 'reject' ? { rejectionReason: body.reason } : {}),
        ...(body.action === 'complete'
          ? {
              // A paid order is settled for exactly what was paid; the shop cannot change it.
              finalAmountPaise:
                order.paymentState === 'paid'
                  ? (order.paidAmountPaise ?? order.estimatedAmountPaise)
                  : (body.finalAmountPaise ?? order.estimatedAmountPaise),
              completedAt: now(),
            }
          : {}),
      });
      if (!updated) {
        throw new HttpError(
          409,
          'This order has already moved on. The list has been refreshed.',
          'invalid_transition',
        );
      }
      await audit.record({
        actorType: 'user',
        actorId: tenant.userId,
        shopId: tenant.shopId,
        action: `order.${body.action}`,
        entity: 'order',
        entityId: orderId,
        metadata: {
          queueNumber: order.queueNumber,
          ...(body.action === 'complete' && body.finalAmountPaise !== undefined
            ? { finalAmountPaise: body.finalAmountPaise }
            : {}),
        },
      });

      if (body.action === 'print') {
        await this.startPrinting(tenant, updated);
      } else {
        await deps.printing.cancelOrder(orderId).catch(() => undefined);
      }
      if (body.action === 'reject') await refundIfPaid([updated]);
      announce(updated);
      return toOwnerView(updated, await this.printStateOf(tenant.shopId, updated.id));
    },

    /** Today's numbers for the shop's own dashboard (the day is the shop's local date). */
    async summary(shopId: string): Promise<OwnerSummary> {
      const shop = await deps.findShopById(shopId);
      if (!shop) throw new HttpError(404, 'Shop not found', 'not_found');
      const date = queueDateFor(now(), shop.timezone);
      const period = { from: date, to: date, shopId };
      const [stats, methods] = await Promise.all([
        repo.statsByShop(period),
        repo.methodTotals(period),
      ]);
      const s = stats.get(shopId);
      return {
        date,
        orders: s?.orders ?? 0,
        printed: s?.printed ?? 0,
        rejected: s?.rejected ?? 0,
        pages: s?.pages ?? 0,
        collectedPaise: s?.collectedPaise ?? 0,
        byMethod: methods,
        counterCount: s?.counterCount ?? 0,
        counterPaise: s?.counterPaise ?? 0,
        refundFailed: s?.refundFailed ?? 0,
      };
    },

    async printStateOf(shopId: string, orderId: string): Promise<OrderPrintState | null> {
      return (await deps.printing.statesFor(shopId, [orderId])).get(orderId) ?? null;
    },

    /**
     * The shop pressed Print. With a printing app the documents are queued for it; without one
     * (or if that fails) the order simply stays "printing" and the shop prints by hand.
     */
    async startPrinting(tenant: { shopId: string; userId: string }, order: OrderRecord) {
      const printable = order.items.filter((i) => i.printPdfKey);
      if (printable.length === 0 || printable.length !== order.items.length) return;
      try {
        const items = [];
        for (const item of printable) {
          const pdf = await storage.get(item.printPdfKey!);
          items.push({
            itemId: item.id,
            name: item.originalName,
            fileKey: item.printPdfKey!,
            fileBytes: item.printPdfBytes,
            colorMode: item.printSettings.colorMode,
            sides: item.printSettings.sides,
            copies: item.printSettings.copies,
            paperSize: item.printSettings.paperSize,
            landscape: await conversion.isLandscape(pdf),
          });
        }
        const mode = await deps.printing.submitOrder({
          shopId: order.shopId,
          orderId: order.id,
          orderLabel: formatQueueNumber(order.queueNumber),
          items,
        });
        await audit.record({
          actorType: 'user',
          actorId: tenant.userId,
          shopId: tenant.shopId,
          action: 'order.print_requested',
          entity: 'order',
          entityId: order.id,
          metadata: { mode },
        });
      } catch (err) {
        logger.error({ err, orderId: order.id }, 'could not queue the order for the printing app');
      }
    },

    /** Retry a failed print, or give up on the printing app and print by hand. */
    async adjustPrinting(
      tenant: { shopId: string; userId: string },
      order: OrderRecord,
      action: 'retry_print' | 'print_manually',
    ): Promise<OwnerOrder> {
      if (order.status !== 'printing') {
        throw new HttpError(409, 'This order is not being printed.', 'invalid_transition');
      }
      if (action === 'retry_print') await deps.printing.retryOrder(order.shopId, order.id);
      else await deps.printing.cancelOrder(order.id);
      await audit.record({
        actorType: 'user',
        actorId: tenant.userId,
        shopId: tenant.shopId,
        action: `order.${action}`,
        entity: 'order',
        entityId: order.id,
      });
      announce(order);
      return toOwnerView(order, await this.printStateOf(order.shopId, order.id));
    },

    /** The printing app finished every document: the order is done. */
    async markPrinted(orderId: string): Promise<void> {
      const order = await repo.findById(orderId);
      if (!order) return;
      const updated = await repo.transition(order.shopId, orderId, ['printing'], {
        status: 'completed',
        finalAmountPaise: order.estimatedAmountPaise,
        completedAt: now(),
      });
      if (!updated) return announce(order);
      await audit.record({
        actorType: 'agent',
        shopId: order.shopId,
        action: 'order.printed',
        entity: 'order',
        entityId: orderId,
        metadata: { queueNumber: order.queueNumber },
      });
      announce(updated);
    },

    /** Refresh the screens of this order's shop and student. */
    async touch(orderId: string): Promise<void> {
      const order = await repo.findById(orderId);
      if (order) announce(order);
    },

    /** The exact PDF that will be printed, for the owner's preview or manual download. */
    async openPrintFile(shopId: string, orderId: string, itemId: string) {
      const order = await repo.findForShop(shopId, orderId);
      const item = order?.items.find((i) => i.id === itemId);
      if (!order || !item?.printPdfKey || order.filesPurgedAt) {
        throw new HttpError(404, 'File not found', 'not_found');
      }
      return {
        stream: storage.createReadStream(item.printPdfKey),
        bytes: item.printPdfBytes,
        fileName: `${formatQueueNumber(order.queueNumber)}-${item.position + 1}.pdf`,
      };
    },

    /** Which realtime room a student's order token maps to (validated by hash lookup). */
    async roomForOrderToken(token: string): Promise<{ room: string; shopRoom: string } | null> {
      const order = await repo.findByLookupHash(hashToken(token));
      return order
        ? { room: `order:${order.lookupTokenHash}`, shopRoom: `shop:${order.shopId}` }
        : null;
    },

    /**
     * Job handler: builds the exact PDF to print for every item (page range, N-up, grayscale)
     * and only then makes the order visible to the shop as `pending`.
     */
    async prepare(orderId: string): Promise<void> {
      const order = await repo.findById(orderId);
      if (!order || order.status !== 'processing') return;

      try {
        for (const item of order.items) {
          const source = await deps.uploads.readNormalized(item.sourceKey);
          const allPages = item.selectedPages.length === item.pageCount;
          const pdf = await conversion.buildPrintPdf({
            source,
            ...(allPages ? {} : { pages: item.selectedPages }),
            colorMode: item.printSettings.colorMode,
            pagesPerSheet: item.printSettings.pagesPerSheet,
            paperSize: item.printSettings.paperSize,
          });
          const pages = await conversion.countPages(pdf);
          const expected = item.printedSides / item.printSettings.copies;
          if (pages !== expected) {
            logger.warn(
              { orderId, itemId: item.id, pages, expected },
              'print PDF page count differs from the priced sides',
            );
          }
          const key = `print/${order.shopId}/${order.id}/${item.id}.pdf`;
          await storage.put(key, pdf);
          await repo.setItemPrintPdf(item.id, {
            printPdfKey: key,
            printPdfBytes: pdf.length,
            printPdfPages: pages,
          });
        }
        await repo.markPending(order.id);
      } catch (err) {
        logger.error({ err, orderId }, 'failed to prepare order');
        await repo.markFailed(order.id, 'Could not prepare the documents for printing');
      }
      announce(order);
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
