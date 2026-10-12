import type { RequestHandler } from 'express';
import type { ApiEnv } from '@print/config';
import { REALTIME, ORDER_LOOKUP_TOKEN_PATTERN } from '@print/contracts';
import type { RateTable } from '@print/domain';
import type { Gate } from '../../platform/capacity/index.js';
import type { Db } from '../../platform/db/client.js';
import type { BotCheck } from '../../platform/http/turnstile.js';
import type { Logger } from '../../platform/observability/logger.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { Realtime } from '../../platform/realtime/index.js';
import type { StorageDriver } from '../../platform/storage/index.js';
import type { Audit } from '../audit/index.js';
import type { Conversion } from '../conversion/index.js';
import type { UsableUpload } from '../documents/index.js';
import { createOwnerOrdersRouter } from './http/owner-routes.js';
import { createOrdersRouter } from './http/routes.js';
import { createOrderRepo } from './repo/order-repo.js';
import { createOrderService, PREPARE_ORDER_JOB, type ShopInfo } from './service/order-service.js';

export type { ShopInfo };

/** Public API of the orders module: the student's journey from print settings to a queue number. */
export function createOrders(deps: {
  db: Db;
  env: ApiEnv;
  logger: Logger;
  storage: StorageDriver;
  queue: JobQueue;
  conversion: Conversion;
  /** Jobs of this module that this process may run at once. */
  jobConcurrency: number;
  previewGate: Gate;
  audit: Audit;
  botCheck: BotCheck;
  realtime: Realtime;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
  canAccessShop: (shopId: string, userId: string) => Promise<boolean>;
  findShopBySlug: (slug: string) => Promise<ShopInfo | null>;
  findShopById: (id: string) => Promise<ShopInfo | null>;
  getRateTable: (shopId: string) => Promise<RateTable>;
  uploads: {
    findUsableForShop(token: string, shopId: string): Promise<UsableUpload>;
    readNormalized(normalizedKey: string): Promise<Buffer>;
    extendExpiry(uploadIds: string[], expiresAt: Date): Promise<void>;
  };
}) {
  const repo = createOrderRepo(deps.db);
  const orders = createOrderService({
    repo,
    storage: deps.storage,
    queue: deps.queue,
    conversion: deps.conversion,
    audit: deps.audit,
    logger: deps.logger,
    botCheck: deps.botCheck,
    realtime: deps.realtime,
    findShopBySlug: deps.findShopBySlug,
    findShopById: deps.findShopById,
    getRateTable: deps.getRateTable,
    uploads: deps.uploads,
    previewGate: deps.previewGate,
    tokenSecret: deps.env.SESSION_SECRET,
    retentionHours: deps.env.RETENTION_HOURS,
    maxCopies: deps.env.MAX_COPIES,
    maxUploadBytes: deps.env.MAX_UPLOAD_BYTES,
  });

  deps.queue.register<{ orderId: string }>(
    PREPARE_ORDER_JOB,
    ({ orderId }) => orders.prepare(orderId),
    {
      concurrency: deps.jobConcurrency,
      timeoutSeconds: 300,
    },
  );

  // Owners and staff follow their shop's queue; the shop is re-checked on every join.
  deps.realtime.handle(REALTIME.watchShop, async (client, payload) => {
    const shopId = (payload as { shopId?: unknown } | null)?.shopId;
    if (
      !client.userId ||
      typeof shopId !== 'string' ||
      !(await deps.canAccessShop(shopId, client.userId))
    ) {
      throw new Error('not_found');
    }
    client.join(`shop:${shopId}`);
  });

  // A student follows one order, identified by the secret token only they hold.
  deps.realtime.handle(REALTIME.watchOrder, async (client, payload) => {
    const token = (payload as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !ORDER_LOOKUP_TOKEN_PATTERN.test(token)) {
      throw new Error('not_found');
    }
    const rooms = await orders.roomForOrderToken(token);
    if (!rooms) throw new Error('not_found');
    client.join(rooms.room);
    client.join(rooms.shopRoom);
  });

  return {
    /** The part of this module other modules may use. */
    api: {
      retire: orders.retire,
      printFileUsage: orders.printFileUsage,
      evictFiles: orders.evictFiles,
    },
    ownerRouter: createOwnerOrdersRouter({
      orders,
      requireAuth: deps.requireAuth,
      requireShopAccess: deps.requireShopAccess,
    }),
    router: createOrdersRouter({
      orders,
      orderRateLimitMax: deps.env.ORDER_RATE_LIMIT_MAX,
      estimateRateLimitMax: deps.env.ESTIMATE_RATE_LIMIT_MAX,
    }),
  };
}

export type Orders = ReturnType<typeof createOrders>;
