import { createHmac, randomBytes } from 'node:crypto';
import {
  type CreateOrderRequest,
  type EstimateItem,
  type EstimateRequest,
  type EstimateResponse,
  type OrderActionBody,
  type OrderItemInput,
  type OrderView,
  type OwnerOrder,
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

export interface OrderServiceDeps {
  repo: OrderRepo;
  storage: StorageDriver;
  queue: JobQueue;
  conversion: Conversion;
  audit: Audit;
  logger: Logger;
  botCheck: BotCheck;
  realtime: Realtime;
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

export function createOrderService(deps: OrderServiceDeps) {
  const { repo, storage, queue, conversion, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

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

  function toOwnerView(order: OrderRecord): OwnerOrder {
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
    ): Promise<{ lookupToken: string; order: OrderView }> {
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
        },
      });

      announce(order);
      return { lookupToken, order: toView(order, shop.name, await repo.aheadCount(order)) };
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

    /** Storage accounting for the print files the orders module holds. */
    printFileUsage: () => repo.printFileUsage(),

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
      return { count: orders.length, bytes };
    },

    /** The shop's working list: what is waiting, being printed, or finished in the last day. */
    async listQueue(shopId: string): Promise<OwnerOrder[]> {
      const since = new Date(now().getTime() - 24 * 3_600_000);
      const orders = await repo.listForShop(shopId, since, 200);
      return orders.map(toOwnerView);
    },

    /** Applies one of the owner's actions. The shop id comes from the authenticated tenant, never the URL alone. */
    async act(
      tenant: { shopId: string; userId: string },
      orderId: string,
      body: OrderActionBody,
    ): Promise<OwnerOrder> {
      const order = await repo.findForShop(tenant.shopId, orderId);
      if (!order) throw new HttpError(404, 'Order not found', 'not_found');

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
              finalAmountPaise: body.finalAmountPaise ?? order.estimatedAmountPaise,
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
      announce(updated);
      return toOwnerView(updated);
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
