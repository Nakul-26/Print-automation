import type { Readable } from 'node:stream';

/**
 * Where document bytes live. Callers only ever deal in relative, server-generated keys
 * (e.g. `originals/<shopId>/<id>.pdf`); the driver decides how they map to disk or a bucket.
 * Swap `LocalDiskStorage` for an object-store implementation without touching callers.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  /** Moves a local file into storage (used for streamed uploads). The source is consumed. */
  putFile(key: string, sourcePath: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  createReadStream(key: string): Readable;
  exists(key: string): Promise<boolean>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
