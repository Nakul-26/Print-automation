import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UploadView } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { JobQueue } from '../../../platform/queue/index.js';
import type { StorageDriver } from '../../../platform/storage/index.js';
import { ProcessingError, type Conversion } from '../../conversion/index.js';
import type { UploadRecord, UploadRepo } from '../repo/upload-repo.js';

export const PROCESS_UPLOAD_JOB = 'document.process-upload';

const HEAD_BYTES = 4100; // enough for content sniffing

export interface UploadServiceDeps {
  repo: UploadRepo;
  storage: StorageDriver;
  queue: JobQueue;
  conversion: Conversion;
  logger: Logger;
  tokenSecret: string;
  retentionHours: number;
  maxStorageBytes: number;
  now?: () => Date;
}

/** Strips path separators and control characters; the name is for display only. */
export function cleanDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'document';
}

export function toView(upload: UploadRecord): UploadView {
  return {
    id: upload.id,
    status: upload.status,
    originalName: upload.originalName,
    pageCount: upload.pageCount,
    errorCode: upload.errorCode,
    errorMessage: upload.errorMessage,
    createdAt: upload.createdAt.toISOString(),
    expiresAt: upload.expiresAt.toISOString(),
  };
}

export function createUploadService(deps: UploadServiceDeps) {
  const { repo, storage, queue, conversion, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const hashToken = (token: string): string =>
    createHmac('sha256', deps.tokenSecret).update(token).digest('hex');

  async function readHead(path: string): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async function sha256OfFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  }

  async function removeFiles(upload: Pick<UploadRecord, 'originalKey' | 'normalizedKey'>) {
    if (upload.originalKey) await storage.delete(upload.originalKey);
    if (upload.normalizedKey) await storage.delete(upload.normalizedKey);
  }

  return {
    /**
     * Accepts a file that multer has already written to a temp path. Always consumes the temp
     * file (moves it into storage or deletes it).
     */
    async create(input: {
      shopId: string;
      tempPath: string;
      originalName: string;
      sizeBytes: number;
    }): Promise<{ token: string; upload: UploadRecord }> {
      try {
        if (input.sizeBytes === 0) throw new HttpError(400, 'The file is empty', 'empty_file');

        // Reject obviously unsupported files before they are stored.
        const detected = await conversion.detectType(await readHead(input.tempPath));
        if (detected.kind === 'unknown') {
          throw new HttpError(
            415,
            'This file type is not supported. Upload a PDF, JPG or PNG.',
            'unsupported_type',
          );
        }
        if (detected.kind === 'office') {
          throw new HttpError(
            415,
            'Word, PowerPoint and Excel files are not supported yet. Please upload a PDF.',
            'unsupported_type',
          );
        }

        // Keep within the platform storage limit.
        const used = await repo.storedBytes();
        if (used + input.sizeBytes * 2 > deps.maxStorageBytes) {
          throw new HttpError(
            503,
            'This shop is very busy right now. Please try again in a few minutes.',
            'storage_full',
          );
        }

        const id = randomUUID();
        const token = randomBytes(24).toString('base64url');
        const originalKey = `originals/${input.shopId}/${id}.${detected.ext}`;
        const contentSha256 = await sha256OfFile(input.tempPath);

        await storage.putFile(originalKey, input.tempPath);
        const upload = await repo.create({
          id,
          shopId: input.shopId,
          tokenHash: hashToken(token),
          originalName: cleanDisplayName(input.originalName),
          detectedMime: detected.mime,
          sizeBytes: input.sizeBytes,
          contentSha256,
          originalKey,
          expiresAt: new Date(now().getTime() + deps.retentionHours * 3_600_000),
        });

        try {
          await queue.enqueue(PROCESS_UPLOAD_JOB, { uploadId: id });
        } catch (err) {
          await storage.delete(originalKey);
          await repo.delete(id);
          throw err;
        }
        return { token, upload };
      } finally {
        await rm(input.tempPath, { force: true });
      }
    },

    /** Job handler: validates and normalises an upload into a print-ready PDF. */
    async process(uploadId: string): Promise<void> {
      const upload = await repo.findById(uploadId);
      if (!upload || upload.status !== 'processing' || !upload.originalKey) return;

      try {
        const original = await storage.get(upload.originalKey);
        const detected = await conversion.detectType(original.subarray(0, HEAD_BYTES));
        const { pdf, pageCount } = await conversion.normalize(original, detected);

        const normalizedKey = `normalized/${upload.shopId}/${upload.id}.pdf`;
        await storage.put(normalizedKey, pdf);
        await repo.markReady(upload.id, {
          normalizedKey,
          normalizedSizeBytes: pdf.length,
          pageCount,
        });
      } catch (err) {
        const known = err instanceof ProcessingError;
        if (!known) logger.error({ err, uploadId }, 'unexpected error processing upload');
        else logger.info({ code: err.code, uploadId }, 'upload rejected');

        await removeFiles({ originalKey: upload.originalKey, normalizedKey: null });
        await repo.markFailed(upload.id, {
          errorCode: known ? err.code : 'processing_failed',
          errorMessage: known
            ? err.message
            : 'Something went wrong while preparing this file. Please try again.',
          filesPurgedAt: now(),
        });
      }
    },

    /** Looks an upload up by its secret token. Expired or purged uploads count as missing. */
    async getByToken(token: string): Promise<UploadRecord> {
      const upload = await repo.findByTokenHash(hashToken(token));
      if (!upload || upload.expiresAt <= now()) {
        throw new HttpError(404, 'Upload not found', 'not_found');
      }
      return upload;
    },

    async openPreview(token: string): Promise<{ stream: Readable; size: number }> {
      const upload = await this.getByToken(token);
      if (upload.status !== 'ready' || !upload.normalizedKey || upload.filesPurgedAt) {
        throw new HttpError(409, 'The preview is not ready', 'not_ready');
      }
      return {
        stream: storage.createReadStream(upload.normalizedKey),
        size: upload.normalizedSizeBytes ?? 0,
      };
    },

    /** The student discards an upload; its files are deleted immediately. */
    async discard(token: string): Promise<void> {
      const upload = await this.getByToken(token);
      await removeFiles(upload);
      await repo.delete(upload.id);
    },
  };
}

export type UploadService = ReturnType<typeof createUploadService>;
