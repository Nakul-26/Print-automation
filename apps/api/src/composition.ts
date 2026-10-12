import type { ApiEnv } from '@print/config';
import { Pool } from 'pg';
import { createAudit } from './modules/audit/index.js';
import { createConversion } from './modules/conversion/index.js';
import { createDocuments } from './modules/documents/index.js';
import { createIdentity, requireAuth } from './modules/identity/index.js';
import { createOrders } from './modules/orders/index.js';
import { createPricing } from './modules/pricing/index.js';
import { createRetention } from './modules/retention/index.js';
import { createShops } from './modules/shops/index.js';
import { createGate, systemCapacity } from './platform/capacity/index.js';
import type { Db } from './platform/db/client.js';
import { createBotCheck } from './platform/http/turnstile.js';
import type { Logger } from './platform/observability/logger.js';
import { PgBossQueue } from './platform/queue/index.js';
import { createRealtime } from './platform/realtime/index.js';
import { LocalDiskStorage } from './platform/storage/index.js';

/**
 * Composition root: the only place that wires modules together.
 * Feature modules receive their dependencies here and never construct each other.
 */
export function createContainer(deps: { env: ApiEnv; logger: Logger; db: Db }) {
  const { env, logger, db } = deps;

  const storage = new LocalDiskStorage(env.STORAGE_ROOT);
  // One process (APP_ROLE=all) needs no cross-process plumbing. With separate web and worker
  // processes, realtime events travel between them through PostgreSQL.
  const sharedPool =
    env.APP_ROLE === 'all' ? null : new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  sharedPool?.on('error', (err) => logger.error({ err }, 'realtime pool error'));
  const capacity = systemCapacity({
    jobMemoryMb: env.JOB_MEMORY_MB,
    jobs: env.WORKER_CONCURRENCY,
    office: env.OFFICE_CONCURRENCY,
    previews: env.PREVIEW_CONCURRENCY,
  });
  const previewGate = createGate(capacity.previews, env.PREVIEW_MAX_WAITING);
  const queue = new PgBossQueue(env.DATABASE_URL, logger, env.APP_ROLE !== 'api');
  const conversion = createConversion({
    gs: { command: env.GS_COMMAND, timeoutMs: env.GS_TIMEOUT_MS },
    office: { command: env.OFFICE_COMMAND, timeoutMs: env.OFFICE_TIMEOUT_MS },
    maxPages: env.MAX_PDF_PAGES,
  });

  const identityRef: { userId?: (header: string | undefined) => Promise<string | null> } = {};
  const realtime = createRealtime({
    logger,
    ...(sharedPool ? { pool: sharedPool } : {}),
    allowedOrigin: env.APP_ORIGIN,
    authenticate: (header) => identityRef.userId?.(header) ?? Promise.resolve(null),
  });

  const audit = createAudit({ db, logger });
  const identity = createIdentity({
    db,
    env,
    audit,
    // Signing out also ends the live connections that were opened with that session.
    onSessionEnded: (userId) => realtime.disconnectUser(userId),
  });
  identityRef.userId = identity.userIdFromCookieHeader;
  const shops = createShops({ db, audit, requireAuth });
  const documents = createDocuments({
    db,
    env,
    logger,
    storage,
    queue,
    conversion,
    concurrency: { quick: capacity.jobs, office: capacity.office },
    findShopBySlug: shops.findBySlug,
  });

  const pricing = createPricing({
    db,
    audit,
    requireAuth,
    requireShopAccess: shops.requireShopAccess,
  });
  const orders = createOrders({
    db,
    env,
    logger,
    storage,
    queue,
    conversion,
    jobConcurrency: capacity.jobs,
    previewGate,
    audit,
    botCheck: createBotCheck({
      secretKey: env.TURNSTILE_SECRET_KEY,
      siteKey: env.TURNSTILE_SITE_KEY,
    }),
    realtime,
    requireAuth,
    requireShopAccess: shops.requireShopAccess,
    canAccessShop: shops.canAccess,
    findShopBySlug: shops.findBySlug,
    findShopById: shops.findById,
    getRateTable: pricing.getRateTable,
    uploads: documents.api,
  });

  const retention = createRetention({
    env,
    logger,
    queue,
    audit,
    documents: documents.api,
    orders: orders.api,
  });

  return {
    audit,
    retention,
    identity,
    shops,
    documents,
    pricing,
    orders,
    conversion,
    storage,
    realtime,
    capacity,
    previewGate,
    /** Starts background job processing. Call once at boot (and in tests that need jobs). */
    start: () => queue.start(),
    stop: async () => {
      await realtime.close();
      await queue.stop();
      await sharedPool?.end();
    },
  };
}

export type Container = ReturnType<typeof createContainer>;
