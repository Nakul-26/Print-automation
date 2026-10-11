import type { ApiEnv } from '@print/config';
import { createAudit } from './modules/audit/index.js';
import { createConversion } from './modules/conversion/index.js';
import { createDocuments } from './modules/documents/index.js';
import { createIdentity, requireAuth } from './modules/identity/index.js';
import { createShops } from './modules/shops/index.js';
import type { Db } from './platform/db/client.js';
import type { Logger } from './platform/observability/logger.js';
import { PgBossQueue } from './platform/queue/index.js';
import { LocalDiskStorage } from './platform/storage/index.js';

/**
 * Composition root: the only place that wires modules together.
 * Feature modules receive their dependencies here and never construct each other.
 */
export function createContainer(deps: { env: ApiEnv; logger: Logger; db: Db }) {
  const { env, logger, db } = deps;

  const storage = new LocalDiskStorage(env.STORAGE_ROOT);
  const queue = new PgBossQueue(env.DATABASE_URL, logger);
  const conversion = createConversion({
    gs: { command: env.GS_COMMAND, timeoutMs: env.GS_TIMEOUT_MS },
    office: { command: env.OFFICE_COMMAND, timeoutMs: env.OFFICE_TIMEOUT_MS },
    maxPages: env.MAX_PDF_PAGES,
  });

  const audit = createAudit({ db, logger });
  const identity = createIdentity({ db, env, audit });
  const shops = createShops({ db, audit, requireAuth });
  const documents = createDocuments({
    db,
    env,
    logger,
    storage,
    queue,
    conversion,
    findShopBySlug: shops.findBySlug,
  });

  return {
    audit,
    identity,
    shops,
    documents,
    conversion,
    storage,
    /** Starts background job processing. Call once at boot (and in tests that need jobs). */
    start: () => queue.start(),
    stop: () => queue.stop(),
  };
}

export type Container = ReturnType<typeof createContainer>;
