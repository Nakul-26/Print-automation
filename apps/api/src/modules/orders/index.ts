import type { ApiEnv } from '@print/config';
import type { RateTable } from '@print/domain';
import type { Db } from '../../platform/db/client.js';
import type { BotCheck } from '../../platform/http/turnstile.js';
import type { Logger } from '../../platform/observability/logger.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { StorageDriver } from '../../platform/storage/index.js';
import type { Audit } from '../audit/index.js';
import type { Conversion } from '../conversion/index.js';
import type { UsableUpload } from '../documents/index.js';
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
  audit: Audit;
  botCheck: BotCheck;
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
    findShopBySlug: deps.findShopBySlug,
    findShopById: deps.findShopById,
    getRateTable: deps.getRateTable,
    uploads: deps.uploads,
    tokenSecret: deps.env.SESSION_SECRET,
    retentionHours: deps.env.RETENTION_HOURS,
    maxCopies: deps.env.MAX_COPIES,
    maxUploadBytes: deps.env.MAX_UPLOAD_BYTES,
  });

  deps.queue.register<{ orderId: string }>(
    PREPARE_ORDER_JOB,
    ({ orderId }) => orders.prepare(orderId),
    {
      concurrency: deps.env.WORKER_CONCURRENCY,
      timeoutSeconds: 300,
    },
  );

  return {
    router: createOrdersRouter({
      orders,
      orderRateLimitMax: deps.env.ORDER_RATE_LIMIT_MAX,
      estimateRateLimitMax: deps.env.ESTIMATE_RATE_LIMIT_MAX,
    }),
  };
}

export type Orders = ReturnType<typeof createOrders>;
