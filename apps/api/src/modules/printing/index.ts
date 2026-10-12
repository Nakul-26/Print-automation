import type { RequestHandler } from 'express';
import type { ApiEnv } from '@print/config';
import { AGENT } from '@print/contracts';
import type { Db } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { Realtime } from '../../platform/realtime/index.js';
import type { StorageDriver } from '../../platform/storage/index.js';
import type { Audit } from '../audit/index.js';
import { createAgentRouter } from './http/agent-routes.js';
import { createOwnerPrintingRouter } from './http/owner-routes.js';
import { createPrintingRepo } from './repo/printing-repo.js';
import {
  createPrintingService,
  type OrdersPort,
  type SubmitOrderInput,
} from './service/printing-service.js';

export type { OrdersPort, SubmitOrderInput };

const SWEEP_JOB = 'printing.sweep';

/** Public API of the printing module: print agents, printer assignment, and print jobs. */
export function createPrinting(deps: {
  db: Db;
  env: ApiEnv;
  logger: Logger;
  storage: StorageDriver;
  queue: JobQueue;
  realtime: Realtime;
  audit: Audit;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
  /** Supplied by the composition root; resolved lazily because orders is built after printing. */
  orders: () => OrdersPort;
  findShopName: (shopId: string) => Promise<string | null>;
  isShopSuspended: (shopId: string) => Promise<boolean>;
}) {
  const repo = createPrintingRepo(deps.db);
  const service = createPrintingService({
    repo,
    storage: deps.storage,
    realtime: deps.realtime,
    audit: deps.audit,
    logger: deps.logger,
    orders: deps.orders,
    findShopName: deps.findShopName,
    isShopSuspended: deps.isShopSuspended,
    tokenSecret: deps.env.SESSION_SECRET,
    staleJobMinutes: deps.env.PRINT_JOB_STALE_MINUTES,
  });

  // The agent's side of the conversation (runs in the web process that holds the socket).
  deps.realtime.agents.handle(AGENT.hello, (agent, payload) => service.onHello(agent, payload));
  deps.realtime.agents.handle(AGENT.jobStatus, (agent, payload) =>
    service.onJobStatus(agent, payload),
  );

  deps.queue.register(SWEEP_JOB, async () => void (await service.sweep()), {
    concurrency: 1,
    timeoutSeconds: 120,
    retryLimit: 0,
  });
  deps.queue.schedule(SWEEP_JOB, '* * * * *');

  return {
    /** The part of this module other modules may use. */
    api: {
      submitOrder: service.submitOrder,
      retryOrder: service.retryOrder,
      cancelOrder: service.cancelOrder,
      statesFor: service.statesFor,
      shopsWithPrintingApp: () => repo.shopsWithDevice(),
    },
    authenticateAgent: service.authenticate,
    sweep: service.sweep,
    agentRouter: createAgentRouter({
      printing: service,
      pairingFailuresMax: deps.env.PAIRING_FAILURES_MAX,
    }),
    ownerRouter: createOwnerPrintingRouter({
      printing: service,
      requireAuth: deps.requireAuth,
      requireShopAccess: deps.requireShopAccess,
    }),
  };
}

export type Printing = ReturnType<typeof createPrinting>;
