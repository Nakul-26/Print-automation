import type { ApiEnv } from '@print/config';
import type { Logger } from '../../platform/observability/logger.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { Audit } from '../audit/index.js';
import {
  createRetentionService,
  type DocumentsPort,
  type OrdersPort,
} from './service/retention-service.js';

export type { SweepResult } from './service/retention-service.js';

export const RETENTION_SWEEP_JOB = 'retention.sweep';

/**
 * Public API of the retention module: deletes files after their retention time, expires old
 * orders, and keeps storage under its limit by removing the oldest files first.
 */
export function createRetention(deps: {
  env: ApiEnv;
  logger: Logger;
  queue: JobQueue;
  audit: Audit;
  documents: DocumentsPort;
  orders: OrdersPort;
  /** The storage limit in bytes. A function so the admin panel can change it without a restart. */
  maxBytes?: () => Promise<number> | number;
}) {
  const service = createRetentionService({
    documents: deps.documents,
    orders: deps.orders,
    audit: deps.audit,
    logger: deps.logger,
    maxBytes: deps.maxBytes ?? (() => deps.env.STORAGE_MAX_BYTES),
    highWatermark: deps.env.STORAGE_HIGH_WATERMARK,
    lowWatermark: deps.env.STORAGE_LOW_WATERMARK,
    stuckProcessingMinutes: deps.env.STUCK_PROCESSING_MINUTES,
  });

  deps.queue.register(RETENTION_SWEEP_JOB, async () => void (await service.sweep()), {
    concurrency: 1,
    timeoutSeconds: 600,
    retryLimit: 0,
  });
  deps.queue.schedule(RETENTION_SWEEP_JOB, deps.env.RETENTION_SWEEP_CRON);

  return { sweep: service.sweep };
}

export type Retention = ReturnType<typeof createRetention>;
