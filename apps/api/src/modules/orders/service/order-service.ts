import { createHmac, randomBytes } from 'node:crypto';
import {
  type CreateOrderRequest,
  type EstimateItem,
  type EstimateRequest,
  type EstimateResponse,
  type OrderItemInput,
  type OrderView,
  type PublicShopInfo,
} from '@print/contracts';
import {
  formatQueueNumber,
  parsePageRanges,
  priceItem,
  priceOrder,
  type RateTable,
} from '@print/domain';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { BotCheck } from '../../../platform/http/turnstile.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { JobQueue } from '../../../platform/queue/index.js';
import type { StorageDriver } from '../../../platform/storage/index.js';
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
  findShopBySlug: (slug: string) => Promise<ShopInfo | null>;
  findShopById: (id: string) => Promise<ShopInfo | null>;
  getRateTable: (shopId: string) => Promise<RateTable>;
  uploads: {
    findUsableForShop(token: string, shopId: string): Promise<UsableUpload>;
    readNormalized(normalizedKey: string): Promise<Buffer>;
    extendExpiry(uploadIds: string[], expiresAt: Date): Promise<void>;
  };
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

      return { lookupToken, order: toView(order, shop.name, await repo.aheadCount(order)) };
    },

    async getByToken(token: string): Promise<OrderView> {
      const order = await repo.findByLookupHash(hashToken(token));
      if (!order) throw new HttpError(404, 'Order not found', 'not_found');
      const shop = await deps.findShopById(order.shopId);
      return toView(order, shop?.name ?? '', await repo.aheadCount(order));
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
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;
