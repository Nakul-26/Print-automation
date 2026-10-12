import type { Db } from '../db/client.js';

export const STORAGE_MAX_BYTES_KEY = 'storage.max_bytes';

/**
 * Platform settings an admin can change while the system runs. Every process reads them from the
 * database (briefly cached), so a change reaches the web and worker processes without a restart.
 */
export function createSettings(deps: {
  db: Db;
  defaults: { storageMaxBytes: number };
  ttlMs?: number;
}) {
  const { db, defaults } = deps;
  const ttlMs = deps.ttlMs ?? 5000;
  let cached: { value: number; at: number } | null = null;

  async function readStorageMax(): Promise<number> {
    const row = await db.platformSetting.findUnique({ where: { key: STORAGE_MAX_BYTES_KEY } });
    return typeof row?.value === 'number' && row.value > 0 ? row.value : defaults.storageMaxBytes;
  }

  return {
    defaultStorageMaxBytes: defaults.storageMaxBytes,

    /** The global storage limit in bytes. */
    async storageMaxBytes(): Promise<number> {
      if (cached && Date.now() - cached.at < ttlMs) return cached.value;
      const value = await readStorageMax();
      cached = { value, at: Date.now() };
      return value;
    },

    async setStorageMaxBytes(bytes: number, updatedBy: string | null): Promise<void> {
      await db.platformSetting.upsert({
        where: { key: STORAGE_MAX_BYTES_KEY },
        create: { key: STORAGE_MAX_BYTES_KEY, value: bytes, updatedBy },
        update: { value: bytes, updatedBy },
      });
      cached = { value: bytes, at: Date.now() };
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
