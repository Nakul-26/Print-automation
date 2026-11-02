import type { RequestHandler } from 'express';
import type { ApiEnv } from '@print/config';
import type { Db } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import { createSecretBox, type PaymentGateway } from '../../platform/payments/index.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { Audit } from '../audit/index.js';
import { createOwnerPaymentsRouter, createStudentPaymentsRouter } from './http/routes.js';
import { createPaymentRepo } from './repo/payment-repo.js';
import {
  createPaymentService,
  REFUND_JOB,
  type OrderContext,
  type OrdersPort,
} from './service/payment-service.js';

export type { OrderContext, OrdersPort };

const SWEEP_JOB = 'payments.sweep';

/**
 * Public API of the payments module: each shop's own payment gateway account, paying for an order
 * on the website, and giving the money back when an order ends without being printed. The money
 * goes straight to the shop's account; the platform never holds it.
 */
export function createPayments(deps: {
  db: Db;
  env: ApiEnv;
  logger: Logger;
  queue: JobQueue;
  audit: Audit;
  gateway: PaymentGateway;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
  /** Supplied by the composition root; resolved lazily because orders is built after payments. */
  orders: () => OrdersPort;
  findShopName: (shopId: string) => Promise<string | null>;
}) {
  const repo = createPaymentRepo(deps.db);
  const service = createPaymentService({
    repo,
    gateway: deps.gateway,
    // Stored keys are encrypted with a key derived from the server secret.
    box: createSecretBox(deps.env.PAYMENTS_ENCRYPTION_KEY ?? deps.env.SESSION_SECRET),
    audit: deps.audit,
    logger: deps.logger,
    queue: deps.queue,
    orders: deps.orders,
    findShopName: deps.findShopName,
  });

  deps.queue.register<{ orderId: string }>(
    REFUND_JOB,
    ({ orderId }) => service.processRefund(orderId),
    { concurrency: 2, timeoutSeconds: 60, retryLimit: 3 },
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
      isEnabled: service.isEnabled,
      prepare: service.prepare,
      attach: service.attach,
      requestRefund: service.requestRefund,
      overviewByShop: service.overviewByShop,
    },
    router: createStudentPaymentsRouter({
      payments: service,
      rateLimitMax: deps.env.ORDER_RATE_LIMIT_MAX,
    }),
    ownerRouter: createOwnerPaymentsRouter({
      payments: service,
      requireAuth: deps.requireAuth,
      requireShopAccess: deps.requireShopAccess,
    }),
    sweep: service.sweep,
  };
}

export type Payments = ReturnType<typeof createPayments>;
