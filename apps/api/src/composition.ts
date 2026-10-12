import type { ApiEnv } from '@print/config';
import { Pool } from 'pg';
import { createAdmin } from './modules/admin/index.js';
import { createAudit } from './modules/audit/index.js';
import { createConversion } from './modules/conversion/index.js';
import { createDocuments } from './modules/documents/index.js';
import { createIdentity, requireAuth, requirePlatformAdmin } from './modules/identity/index.js';
import { createOrders } from './modules/orders/index.js';
import { createPricing, DEFAULT_RATES } from './modules/pricing/index.js';
import { createPrinting } from './modules/printing/index.js';
import { createRetention } from './modules/retention/index.js';
import { createShops } from './modules/shops/index.js';
import { createGate, systemCapacity } from './platform/capacity/index.js';
import type { Db } from './platform/db/client.js';
import { createBotCheck } from './platform/http/turnstile.js';
import type { Logger } from './platform/observability/logger.js';
import { PgBossQueue } from './platform/queue/index.js';
import { createRealtime } from './platform/realtime/index.js';
import { createSettings } from './platform/settings/index.js';
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
  const printingRef: {
    authenticate?: (token: string) => Promise<{ deviceId: string; shopId: string } | null>;
  } = {};
  const realtime = createRealtime({
    logger,
    ...(sharedPool ? { pool: sharedPool } : {}),
    allowedOrigin: env.APP_ORIGIN,
    authenticateAgent: (token) => printingRef.authenticate?.(token) ?? Promise.resolve(null),
    authenticate: (header) => identityRef.userId?.(header) ?? Promise.resolve(null),
  });

  const audit = createAudit({ db, logger });
  const settings = createSettings({ db, defaults: { storageMaxBytes: env.STORAGE_MAX_BYTES } });
  const botCheck = createBotCheck({
    secretKey: env.TURNSTILE_SECRET_KEY,
    siteKey: env.TURNSTILE_SITE_KEY,
  });
  const identity = createIdentity({
    db,
    env,
    audit,
    // Signing out also ends the live connections that were opened with that session.
    onSessionEnded: (userId) => realtime.disconnectUser(userId),
  });
  identityRef.userId = identity.userIdFromCookieHeader;
  const shops = createShops({
    db,
    audit,
    requireAuth,
    // A suspended shop loses its live connections at once: the owner's dashboards and the printing app.
    onSuspended: (shopId) => {
      realtime.disconnectRoom(`shop:${shopId}`);
      realtime.agents.disconnectShop(shopId);
    },
  });
  const documents = createDocuments({
    db,
    env,
    logger,
    storage,
    queue,
    conversion,
    concurrency: { quick: capacity.jobs, office: capacity.office },
    findShopBySlug: shops.findBySlug,
    maxStorageBytes: settings.storageMaxBytes,
  });

  const pricing = createPricing({
    db,
    audit,
    requireAuth,
    requireShopAccess: shops.requireShopAccess,
  });
  // Printing and orders talk to each other through narrow ports; orders is built second.
  const ordersRef: { current?: ReturnType<typeof createOrders> } = {};
  const printing = createPrinting({
    db,
    env,
    logger,
    storage,
    queue,
    realtime,
    audit,
    requireAuth,
    requireShopAccess: shops.requireShopAccess,
    orders: () => ({
      markPrinted: (orderId) => ordersRef.current!.api.markPrinted(orderId),
      touch: (orderId) => ordersRef.current!.api.touch(orderId),
    }),
    findShopName: async (shopId) => (await shops.findById(shopId))?.name ?? null,
    isShopSuspended: async (shopId) => (await shops.findById(shopId))?.status === 'suspended',
  });
  printingRef.authenticate = printing.authenticateAgent;
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
    botCheck,
    realtime,
    printing: printing.api,
    requireAuth,
    requireShopAccess: shops.requireShopAccess,
    canAccessShop: shops.canAccess,
    findShopBySlug: shops.findBySlug,
    findShopById: shops.findById,
    getRateTable: pricing.getRateTable,
    uploads: documents.api,
  });

  ordersRef.current = orders;

  const retention = createRetention({
    env,
    logger,
    queue,
    audit,
    documents: documents.api,
    orders: orders.api,
    maxBytes: settings.storageMaxBytes,
  });

  const admin = createAdmin({
    settings,
    audit,
    requireAuth,
    requirePlatformAdmin,
    botVerify: (token, ip) => botCheck.verify(token, ip),
    applyRateLimitMax: env.APPLY_RATE_LIMIT_MAX,
    botSiteKey: botCheck.siteKey,
    ports: {
      shops: {
        checkSlug: shops.checkSlug,
        createShop: (input) => shops.createShop(input),
        addOwner: (shopId, userId) => shops.addMember({ shopId, userId, role: 'owner' }),
        listForAdmin: shops.listForAdmin,
        changeStatus: shops.changeStatus,
        setLimits: shops.setLimits,
      },
      identity: {
        findUserByEmail: identity.users.findByEmail,
        createUser: identity.users.create,
      },
      applyStarterRates: (shopId) => pricing.setRates(shopId, DEFAULT_RATES),
      usage: {
        storageByShop: documents.api.storedBytesByShop,
        storageTotal: async () => {
          const [uploads, printFiles] = await Promise.all([
            documents.api.storedBytes(),
            orders.api.printFileUsage(),
          ]);
          return uploads + printFiles.reduce((sum, p) => sum + p.bytes, 0);
        },
        ordersByShop: orders.api.countsByShop,
        shopsWithRates: pricing.shopsWithRates,
        shopsWithPrintingApp: printing.api.shopsWithPrintingApp,
      },
    },
  });

  return {
    audit,
    retention,
    admin,
    settings,
    printing,
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
