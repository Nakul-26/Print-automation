import type { Db } from '../../../platform/db/client.js';

export interface ConversionVariant {
  key: string;
  size: number;
  pages: number;
  settings: Record<string, unknown>;
}
export type ConversionVariants = Record<string, ConversionVariant>;

/** An upload together with whether an order was placed with it. */
export type StoredUpload = UploadRecord & { orderItem: { orderId: string } | null };

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
  updatedAt: Date;
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

    /** Uploads whose retention time has passed but whose files are still on disk. */
    async listExpired(now: Date, limit: number): Promise<StoredUpload[]> {
      const rows = await db.upload.findMany({
        where: { filesPurgedAt: null, expiresAt: { lte: now } },
        include: { orderItem: { select: { orderId: true } } },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      });
      return rows.map((row) => toRecord(row) as StoredUpload);
    },

    /** Every upload that still has files, oldest first. */
    async listStored(): Promise<StoredUpload[]> {
      const rows = await db.upload.findMany({
        where: { filesPurgedAt: null },
        include: { orderItem: { select: { orderId: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => toRecord(row) as StoredUpload);
    },

    async findManyStored(ids: string[]): Promise<StoredUpload[]> {
      const rows = await db.upload.findMany({
        where: { id: { in: ids }, filesPurgedAt: null },
        include: { orderItem: { select: { orderId: true } } },
      });
      return rows.map((row) => toRecord(row) as StoredUpload);
    },

    /** Keeps the row (an order still points at it) but forgets where the files were. */
    async markPurged(id: string, at: Date): Promise<void> {
      await db.upload.updateMany({
        where: { id },
        data: {
          filesPurgedAt: at,
          originalKey: null,
          normalizedKey: null,
          normalizedSizeBytes: null,
          conversionVariants: null as never,
        },
      });
    },

    /**
     * Bytes currently held on disk for uploads whose files have not been purged. Summed in the
     * database: every upload checks this, so it must not read every row into memory.
     */
    async storedBytes(): Promise<number> {
      const rows = await db.$queryRaw<{ total: number }[]>`
        SELECT COALESCE(SUM(
          size_bytes + CASE
            WHEN jsonb_typeof(conversion_variants) = 'object' AND conversion_variants <> '{}'::jsonb
              THEN (SELECT COALESCE(SUM((v.value ->> 'size')::bigint), 0) FROM jsonb_each(conversion_variants) v)
            ELSE COALESCE(normalized_size_bytes, 0)
          END
        ), 0)::float8 AS total
        FROM uploads
        WHERE files_purged_at IS NULL`;
      return Number(rows[0]?.total ?? 0);
    },

    /**
     * Files of the same kind of work that were queued before this one and are still being
     * prepared (including the ones being worked on right now).
     */
    async countProcessingAhead(upload: {
      id: string;
      updatedAt: Date;
      office: boolean;
    }): Promise<number> {
      return db.upload.count({
        where: {
          status: 'processing',
          id: { not: upload.id },
          updatedAt: { lt: upload.updatedAt },
          documentKind: upload.office ? 'office' : { not: 'office' },
        },
      });
    },
  };
}

export type UploadRepo = ReturnType<typeof createUploadRepo>;
