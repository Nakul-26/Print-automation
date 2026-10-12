import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  defaultOfficeSettings,
  OFFICE_SETTINGS_SCHEMAS,
  type OfficeFamily,
  type OfficeSettings,
  type UploadView,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { JobQueue } from '../../../platform/queue/index.js';
import type { StorageDriver } from '../../../platform/storage/index.js';
import {
  ProcessingError,
  UNSUPPORTED_LEGACY_MESSAGE,
  type Conversion,
} from '../../conversion/index.js';
import type {
  ConversionVariants,
  StoredUpload,
  UploadRecord,
  UploadRepo,
} from '../repo/upload-repo.js';

/** Quick lane: PDFs and images. */
export const PROCESS_UPLOAD_JOB = 'document.process-upload';
/**
 * Slow lane: Word, Excel and PowerPoint (LibreOffice). A separate queue with its own small
 * worker pool, so a burst of Office files cannot hold up quick PDF and image jobs.
 */
export const PROCESS_OFFICE_JOB = 'document.process-office';

const jobNameFor = (kind: string): string =>
  kind === 'office' ? PROCESS_OFFICE_JOB : PROCESS_UPLOAD_JOB;

export interface ProcessUploadJob {
  uploadId: string;
  /** The conversion revision this job was queued for; stale jobs are ignored. */
  revision: number;
}

/** ZIP-based Office files list their parts near the start; the first entry can be large. */
const SNIFF_BYTES = 512 * 1024;

export interface UsableUpload {
  id: string;
  shopId: string;
  originalName: string;
  pageCount: number;
  normalizedKey: string;
}

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

export function toView(upload: UploadRecord, queueAhead: number | null = null): UploadView {
  return {
    id: upload.id,
    status: upload.status,
    originalName: upload.originalName,
    documentKind: upload.documentKind,
    officeFamily: upload.officeFamily,
    conversionSettings: upload.conversionSettings,
    revision: upload.conversionRevision,
    pageCount: upload.pageCount,
    queueAhead: upload.status === 'processing' ? queueAhead : null,
    errorCode: upload.errorCode,
    errorMessage: upload.errorMessage,
    createdAt: upload.createdAt.toISOString(),
    expiresAt: upload.expiresAt.toISOString(),
  };
}

/** JSON with sorted keys, so equal settings always hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function settingsHash(settings: OfficeSettings): string {
  return createHash('sha256').update(canonicalJson(settings)).digest('hex').slice(0, 16);
}

export function createUploadService(deps: UploadServiceDeps) {
  const { repo, storage, queue, conversion, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const hashToken = (token: string): string =>
    createHmac('sha256', deps.tokenSecret).update(token).digest('hex');

  async function readHead(path: string): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
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

  async function removeFiles(upload: UploadRecord): Promise<void> {
    const keys = new Set<string>();
    if (upload.originalKey) keys.add(upload.originalKey);
    if (upload.normalizedKey) keys.add(upload.normalizedKey);
    for (const variant of Object.values(upload.conversionVariants ?? {})) keys.add(variant.key);
    for (const key of keys) await storage.delete(key);
  }

  /** Bytes this upload occupies on disk: the original plus every converted variant. */
  function bytesOf(upload: UploadRecord): number {
    const variants = Object.values(upload.conversionVariants ?? {});
    const converted =
      variants.length > 0
        ? variants.reduce((sum, v) => sum + v.size, 0)
        : (upload.normalizedSizeBytes ?? 0);
    return upload.sizeBytes + converted;
  }

  /** Deletes the files. A row an order points at stays (without files); any other row goes too. */
  async function purge(upload: StoredUpload): Promise<number> {
    const bytes = bytesOf(upload);
    await removeFiles(upload);
    if (upload.orderItem) await repo.markPurged(upload.id, now());
    else await repo.delete(upload.id);
    return bytes;
  }

  function parseSettings(family: OfficeFamily, raw: unknown): OfficeSettings {
    const parsed = OFFICE_SETTINGS_SCHEMAS[family].safeParse(raw ?? {});
    if (!parsed.success) {
      throw new HttpError(400, 'Those conversion settings are not valid', 'invalid_settings');
    }
    return parsed.data;
  }

  /** Settings recorded for the variant that is currently shown, used to undo a failed change. */
  function activeSettings(upload: UploadRecord): Record<string, unknown> {
    const active = Object.values(upload.conversionVariants ?? {}).find(
      (v) => v.key === upload.normalizedKey,
    );
    return (
      active?.settings ??
      (upload.officeFamily
        ? (defaultOfficeSettings(upload.officeFamily) as Record<string, unknown>)
        : {})
    );
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

        // Reject unsupported files before they are stored.
        const detected = await conversion.detectType(await readHead(input.tempPath));
        if (detected.kind === 'unknown') {
          throw new HttpError(
            415,
            'This file type is not supported. Upload a PDF, Word, PowerPoint, Excel, JPG or PNG file.',
            'unsupported_type',
          );
        }
        if (detected.kind === 'legacy_office') {
          throw new HttpError(415, UNSUPPORTED_LEGACY_MESSAGE, 'unsupported_type');
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
        const family = detected.kind === 'office' ? (detected.family ?? null) : null;

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
          documentKind: detected.kind === 'office' ? 'office' : detected.kind,
          officeFamily: family,
          conversionSettings: family
            ? (defaultOfficeSettings(family) as Record<string, unknown>)
            : null,
          expiresAt: new Date(now().getTime() + deps.retentionHours * 3_600_000),
        });

        try {
          await queue.enqueue<ProcessUploadJob>(jobNameFor(upload.documentKind), {
            uploadId: id,
            revision: 0,
          });
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
    async process(job: ProcessUploadJob): Promise<void> {
      const upload = await repo.findById(job.uploadId);
      if (
        !upload ||
        upload.status !== 'processing' ||
        upload.conversionRevision !== job.revision ||
        !upload.originalKey
      ) {
        return; // gone, already handled, or overtaken by newer settings
      }

      const family = upload.officeFamily;
      const settings = family ? parseSettings(family, upload.conversionSettings) : undefined;
      const variantId = settings ? settingsHash(settings) : 'default';

      try {
        const variants: ConversionVariants = upload.conversionVariants ?? {};

        // Same settings converted before: switch back instantly.
        const cached = variants[variantId];
        if (cached && (await storage.exists(cached.key))) {
          await repo.markReady(upload.id, job.revision, {
            normalizedKey: cached.key,
            normalizedSizeBytes: cached.size,
            pageCount: cached.pages,
          });
          return;
        }

        const original = await storage.get(upload.originalKey);
        const detected = await conversion.detectType(original.subarray(0, SNIFF_BYTES));
        const { pdf, pageCount } = await conversion.normalize(original, detected, settings);

        const normalizedKey = settings
          ? `normalized/${upload.shopId}/${upload.id}.${variantId}.pdf`
          : `normalized/${upload.shopId}/${upload.id}.pdf`;
        await storage.put(normalizedKey, pdf);

        const nextVariants: ConversionVariants | undefined = settings
          ? {
              ...variants,
              [variantId]: {
                key: normalizedKey,
                size: pdf.length,
                pages: pageCount,
                settings: settings as Record<string, unknown>,
              },
            }
          : undefined;
        const applied = await repo.markReady(upload.id, job.revision, {
          normalizedKey,
          normalizedSizeBytes: pdf.length,
          pageCount,
          ...(nextVariants ? { conversionVariants: nextVariants } : {}),
        });
        if (!applied) await storage.delete(normalizedKey); // overtaken while converting
      } catch (err) {
        const known = err instanceof ProcessingError;
        if (!known)
          logger.error({ err, uploadId: job.uploadId }, 'unexpected error processing upload');
        else logger.info({ code: err.code, uploadId: job.uploadId }, 'upload processing failed');

        const errorCode = known ? err.code : 'processing_failed';
        const errorMessage = known
          ? err.message
          : 'Something went wrong while preparing this file. Please try again.';

        if (upload.normalizedKey) {
          // A settings change failed; the previous preview is still good.
          await repo.revertToPrevious(upload.id, job.revision, {
            errorCode,
            errorMessage: `Those settings could not be applied: ${errorMessage}`,
            conversionSettings: activeSettings(upload),
          });
        } else {
          await removeFiles(upload);
          await repo.markFailed(upload.id, job.revision, {
            errorCode,
            errorMessage,
            filesPurgedAt: now(),
          });
        }
      }
    },

    /**
     * Changes how an Office document is converted. Returns immediately if these settings were
     * converted before; otherwise queues a conversion and the upload goes back to `processing`.
     */
    async changeConversion(token: string, rawSettings: unknown): Promise<UploadRecord> {
      const upload = await this.getByToken(token);
      if (upload.documentKind !== 'office' || !upload.officeFamily) {
        throw new HttpError(400, 'This document has no conversion settings', 'not_convertible');
      }
      if (upload.status === 'processing') {
        throw new HttpError(409, 'Still converting, wait for the preview first', 'busy');
      }
      if (upload.status !== 'ready' || !upload.originalKey) {
        throw new HttpError(409, 'This upload can no longer be changed', 'not_ready');
      }

      const settings = parseSettings(upload.officeFamily, rawSettings);
      const hash = settingsHash(settings);
      const cached = upload.conversionVariants?.[hash];
      if (cached && (await storage.exists(cached.key))) {
        await repo.activateVariant(upload.id, {
          normalizedKey: cached.key,
          normalizedSizeBytes: cached.size,
          pageCount: cached.pages,
          conversionSettings: settings as Record<string, unknown>,
        });
      } else {
        const started = await repo.beginReconversion(
          upload.id,
          upload.conversionRevision,
          settings as Record<string, unknown>,
        );
        if (!started) throw new HttpError(409, 'The document changed, try again', 'conflict');
        try {
          await queue.enqueue<ProcessUploadJob>(PROCESS_OFFICE_JOB, {
            uploadId: upload.id,
            revision: upload.conversionRevision + 1,
          });
        } catch (err) {
          await repo.revertToPrevious(upload.id, upload.conversionRevision + 1, {
            errorCode: 'processing_failed',
            errorMessage: 'Could not start the conversion. Please try again.',
            conversionSettings: activeSettings(upload),
          });
          throw err;
        }
      }
      return this.getByToken(token);
    },

    /** Shown to the student while their file waits: how many files are ahead of it. */
    async queueAheadOf(upload: UploadRecord): Promise<number | null> {
      if (upload.status !== 'processing') return null;
      return repo.countProcessingAhead({
        id: upload.id,
        updatedAt: upload.updatedAt,
        office: upload.documentKind === 'office',
      });
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

    /**
     * For the ordering flow: the upload behind a token, provided it belongs to this shop and
     * its converted PDF is ready to be printed.
     */
    async findUsableForShop(token: string, shopId: string): Promise<UsableUpload> {
      const upload = await this.getByToken(token);
      if (upload.shopId !== shopId) {
        throw new HttpError(404, 'Upload not found', 'not_found');
      }
      if (upload.status !== 'ready' || !upload.normalizedKey || upload.pageCount === null) {
        throw new HttpError(
          409,
          `"${upload.originalName}" is not ready yet. Wait for the preview to finish.`,
          'upload_not_ready',
        );
      }
      return {
        id: upload.id,
        shopId: upload.shopId,
        originalName: upload.originalName,
        pageCount: upload.pageCount,
        normalizedKey: upload.normalizedKey,
      };
    },

    /** The converted PDF of an upload (what the print job is built from). */
    async readNormalized(normalizedKey: string): Promise<Buffer> {
      return storage.get(normalizedKey);
    },

    /** Retention: deletes the files of every upload past its expiry. */
    async purgeExpired(at: Date): Promise<{ count: number; bytes: number }> {
      let count = 0;
      let bytes = 0;
      for (;;) {
        const batch = await repo.listExpired(at, 200);
        if (batch.length === 0) break;
        for (const upload of batch) {
          bytes += await purge(upload);
          count++;
        }
        if (batch.length < 200) break;
      }
      return { count, bytes };
    },

    /** What is on disk, oldest first, and which order (if any) each upload belongs to. */
    async storedUploads(): Promise<
      { uploadId: string; orderId: string | null; createdAt: Date; bytes: number }[]
    > {
      return (await repo.listStored()).map((u) => ({
        uploadId: u.id,
        orderId: u.orderItem?.orderId ?? null,
        createdAt: u.createdAt,
        bytes: bytesOf(u),
      }));
    },

    /** Storage pressure: deletes the files of the given uploads. */
    async purgeUploads(ids: string[]): Promise<{ count: number; bytes: number }> {
      let bytes = 0;
      const found = await repo.findManyStored(ids);
      for (const upload of found) bytes += await purge(upload);
      return { count: found.length, bytes };
    },

    /** Keeps the files of ordered uploads until the order's own expiry. */
    extendExpiry(uploadIds: string[], expiresAt: Date): Promise<void> {
      return repo.setExpiry(uploadIds, expiresAt);
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
