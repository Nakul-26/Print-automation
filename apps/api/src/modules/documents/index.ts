import type { ApiEnv } from '@print/config';
import type { Db } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';
import type { JobQueue } from '../../platform/queue/index.js';
import type { StorageDriver } from '../../platform/storage/index.js';
import type { Conversion } from '../conversion/index.js';
import { createUploadsRouter, uploadTempDir, type PublicShop } from './http/routes.js';
import { createUploadRepo } from './repo/upload-repo.js';
import {
  createUploadService,
  PROCESS_UPLOAD_JOB,
  type ProcessUploadJob,
} from './service/upload-service.js';

export type { PublicShop };
export type { UsableUpload } from './service/upload-service.js';

/** Public API of the documents module: student uploads and their processing. */
export function createDocuments(deps: {
  db: Db;
  env: ApiEnv;
  logger: Logger;
  storage: StorageDriver;
  queue: JobQueue;
  conversion: Conversion;
  findShopBySlug: (slug: string) => Promise<PublicShop | null>;
}) {
  const repo = createUploadRepo(deps.db);
  const uploads = createUploadService({
    repo,
    storage: deps.storage,
    queue: deps.queue,
    conversion: deps.conversion,
    logger: deps.logger,
    tokenSecret: deps.env.SESSION_SECRET,
    retentionHours: deps.env.RETENTION_HOURS,
    maxStorageBytes: deps.env.STORAGE_MAX_BYTES,
  });

  deps.queue.register<ProcessUploadJob>(PROCESS_UPLOAD_JOB, (job) => uploads.process(job), {
    concurrency: deps.env.WORKER_CONCURRENCY,
    timeoutSeconds: 300,
  });

  return {
    /** The part of this module other modules may use. */
    api: {
      findUsableForShop: uploads.findUsableForShop.bind(uploads),
      readNormalized: uploads.readNormalized.bind(uploads),
      extendExpiry: uploads.extendExpiry.bind(uploads),
    },
    router: createUploadsRouter({
      uploads,
      findShopBySlug: deps.findShopBySlug,
      tempDir: uploadTempDir(deps.env.STORAGE_ROOT),
      maxUploadBytes: deps.env.MAX_UPLOAD_BYTES,
      rateLimitMax: deps.env.UPLOAD_RATE_LIMIT_MAX,
      convertRateLimitMax: deps.env.CONVERT_RATE_LIMIT_MAX,
    }),
  };
}

export type Documents = ReturnType<typeof createDocuments>;
