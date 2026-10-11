import type { Db } from '../../../platform/db/client.js';

export interface ConversionVariant {
  key: string;
  size: number;
  pages: number;
  settings: Record<string, unknown>;
}
export type ConversionVariants = Record<string, ConversionVariant>;

export interface UploadRecord {
  id: string;
  shopId: string;
  originalName: string;
  detectedMime: string;
  sizeBytes: number;
  contentSha256: string;
  status: 'processing' | 'ready' | 'failed';
  documentKind: 'pdf' | 'image' | 'office';
  officeFamily: 'writer' | 'calc' | 'impress' | null;
  conversionSettings: Record<string, unknown> | null;
  conversionRevision: number;
  conversionVariants: ConversionVariants | null;
  errorCode: string | null;
  errorMessage: string | null;
  pageCount: number | null;
  originalKey: string | null;
  normalizedKey: string | null;
  normalizedSizeBytes: number | null;
  createdAt: Date;
  expiresAt: Date;
  filesPurgedAt: Date | null;
}

/** Prisma returns JSON columns as `JsonValue`; this narrows the rows to our record type. */
function toRecord<T extends { conversionSettings: unknown; conversionVariants: unknown }>(
  row: T,
): UploadRecord {
  return row as unknown as UploadRecord;
}

/** The only code in this module that touches the database. */
export function createUploadRepo(db: Db) {
  return {
    async create(data: {
      id: string;
      shopId: string;
      tokenHash: string;
      originalName: string;
      detectedMime: string;
      sizeBytes: number;
      contentSha256: string;
      originalKey: string;
      documentKind: 'pdf' | 'image' | 'office';
      officeFamily: string | null;
      conversionSettings: Record<string, unknown> | null;
      expiresAt: Date;
    }): Promise<UploadRecord> {
      return toRecord(
        await db.upload.create({
          data: { ...data, conversionSettings: (data.conversionSettings ?? undefined) as never },
        }),
      );
    },

    async findById(id: string): Promise<UploadRecord | null> {
      const row = await db.upload.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async findByTokenHash(tokenHash: string): Promise<UploadRecord | null> {
      const row = await db.upload.findUnique({ where: { tokenHash } });
      return row ? toRecord(row) : null;
    },

    /**
     * Completes a conversion. Guarded by `revision` so a job that was overtaken by newer
     * settings cannot overwrite them. Returns false if the job was stale.
     */
    async markReady(
      id: string,
      revision: number,
      data: {
        normalizedKey: string;
        normalizedSizeBytes: number;
        pageCount: number;
        conversionVariants?: ConversionVariants;
      },
    ): Promise<boolean> {
      const { conversionVariants, ...rest } = data;
      const { count } = await db.upload.updateMany({
        where: { id, conversionRevision: revision },
        data: {
          ...rest,
          ...(conversionVariants ? { conversionVariants: conversionVariants as never } : {}),
          status: 'ready',
          errorCode: null,
          errorMessage: null,
        },
      });
      return count === 1;
    },

    /** A first conversion failed: nothing usable exists, so the upload is dead. */
    async markFailed(
      id: string,
      revision: number,
      data: { errorCode: string; errorMessage: string; filesPurgedAt: Date },
    ): Promise<void> {
      await db.upload.updateMany({
        where: { id, conversionRevision: revision },
        data: {
          ...data,
          status: 'failed',
          originalKey: null,
          normalizedKey: null,
          conversionVariants: null as never,
        },
      });
    },

    /**
     * A re-conversion with new settings failed: keep the previous preview usable, restore
     * its settings, and report why the change could not be applied.
     */
    async revertToPrevious(
      id: string,
      revision: number,
      data: {
        errorCode: string;
        errorMessage: string;
        conversionSettings: Record<string, unknown>;
      },
    ): Promise<void> {
      await db.upload.updateMany({
        where: { id, conversionRevision: revision },
        data: {
          status: 'ready',
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
          conversionSettings: data.conversionSettings as never,
        },
      });
    },

    /** Starts a re-conversion: new settings, new revision, back to processing. */
    async beginReconversion(
      id: string,
      fromRevision: number,
      settings: Record<string, unknown>,
    ): Promise<boolean> {
      const { count } = await db.upload.updateMany({
        where: { id, conversionRevision: fromRevision, status: 'ready' },
        data: {
          status: 'processing',
          conversionSettings: settings as never,
          conversionRevision: fromRevision + 1,
          errorCode: null,
          errorMessage: null,
        },
      });
      return count === 1;
    },

    /** Switches to an already-converted variant without running a job. */
    async activateVariant(
      id: string,
      data: {
        normalizedKey: string;
        normalizedSizeBytes: number;
        pageCount: number;
        conversionSettings: Record<string, unknown>;
      },
    ): Promise<void> {
      await db.upload.update({
        where: { id },
        data: {
          ...data,
          conversionSettings: data.conversionSettings as never,
          status: 'ready',
          errorCode: null,
          errorMessage: null,
        },
      });
    },

    /** Moves the expiry of the given uploads (used when they become part of an order). */
    async setExpiry(ids: string[], expiresAt: Date): Promise<void> {
      await db.upload.updateMany({ where: { id: { in: ids } }, data: { expiresAt } });
    },

    async delete(id: string): Promise<void> {
      await db.upload.deleteMany({ where: { id } });
    },

    /** Bytes currently held on disk for uploads whose files have not been purged. */
    async storedBytes(): Promise<number> {
      const rows = await db.upload.findMany({
        where: { filesPurgedAt: null },
        select: { sizeBytes: true, conversionVariants: true, normalizedSizeBytes: true },
      });
      let total = 0;
      for (const row of rows) {
        total += row.sizeBytes;
        const variants = row.conversionVariants as ConversionVariants | null;
        if (variants && Object.keys(variants).length > 0) {
          for (const v of Object.values(variants)) total += v.size;
        } else {
          total += row.normalizedSizeBytes ?? 0;
        }
      }
      return total;
    },
  };
}

export type UploadRepo = ReturnType<typeof createUploadRepo>;
