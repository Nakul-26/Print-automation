import type { ApiEnv } from '@print/config';
import { createAudit } from './modules/audit/index.js';
import { createIdentity, requireAuth } from './modules/identity/index.js';
import { createShops } from './modules/shops/index.js';
import type { Db } from './platform/db/client.js';
import type { Logger } from './platform/observability/logger.js';

/**
 * Composition root: the only place that wires modules together.
 * Feature modules receive their dependencies here and never construct each other.
 */
export function createContainer(deps: { env: ApiEnv; logger: Logger; db: Db }) {
  const audit = createAudit({ db: deps.db, logger: deps.logger });
  const identity = createIdentity({ db: deps.db, env: deps.env, audit });
  const shops = createShops({ db: deps.db, audit, requireAuth });
  return { audit, identity, shops };
}

export type Container = ReturnType<typeof createContainer>;
