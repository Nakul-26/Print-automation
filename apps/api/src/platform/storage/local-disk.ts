import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { StorageDriver } from './driver.js';

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Stores files under one root directory. Writes are atomic (temp file + rename). */
export class LocalDiskStorage implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Maps a key to a path, refusing anything that could escape the root. */
  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  private tempPathFor(full: string): string {
    return `${full}.${randomBytes(6).toString('hex')}.tmp`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const tmp = this.tempPathFor(full);
    try {
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, full);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    try {
      await rename(sourcePath, full);
    } catch {
      // Cross-device move (e.g. temp dir on another volume): copy then remove the source.
      const tmp = this.tempPathFor(full);
      try {
        await copyFile(sourcePath, tmp);
        await rename(tmp, full);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      await rm(sourcePath, { force: true });
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  createReadStream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
