import type { Db } from '../../../platform/db/client.js';

export interface UploadRecord {
  id: string;
  shopId: string;
  originalName: string;
  detectedMime: string;
  sizeBytes: number;
  contentSha256: string;
  status: 'processing' | 'ready' | 'failed';
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

/** The only code in this module that touches the database. */
export function createUploadRepo(db: Db) {
  return {
    create(data: {
      id: string;
      shopId: string;
      tokenHash: string;
      originalName: string;
      detectedMime: string;
      sizeBytes: number;
      contentSha256: string;
      originalKey: string;
      expiresAt: Date;
    }): Promise<UploadRecord> {
      return db.upload.create({ data });
    },

    findById(id: string): Promise<UploadRecord | null> {
      return db.upload.findUnique({ where: { id } });
    },

    findByTokenHash(tokenHash: string): Promise<UploadRecord | null> {
      return db.upload.findUnique({ where: { tokenHash } });
    },

    async markReady(
      id: string,
      data: { normalizedKey: string; normalizedSizeBytes: number; pageCount: number },
    ): Promise<void> {
      await db.upload.update({ where: { id }, data: { ...data, status: 'ready' } });
    },

    async markFailed(
      id: string,
      data: { errorCode: string; errorMessage: string; filesPurgedAt: Date },
    ): Promise<void> {
      await db.upload.update({
        where: { id },
        data: { ...data, status: 'failed', originalKey: null, normalizedKey: null },
      });
    },

    async delete(id: string): Promise<void> {
      await db.upload.deleteMany({ where: { id } });
    },

    /** Bytes currently held on disk for uploads whose files have not been purged. */
    async storedBytes(): Promise<number> {
      const sums = await db.upload.aggregate({
        where: { filesPurgedAt: null },
        _sum: { sizeBytes: true, normalizedSizeBytes: true },
      });
      return (sums._sum.sizeBytes ?? 0) + (sums._sum.normalizedSizeBytes ?? 0);
    },
  };
}

export type UploadRepo = ReturnType<typeof createUploadRepo>;
