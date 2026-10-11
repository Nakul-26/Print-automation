import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../src/platform/storage/index.js';

let root: string;
let storage: LocalDiskStorage;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'print-storage-'));
  storage = new LocalDiskStorage(root);
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('LocalDiskStorage', () => {
  it('stores, reads, checks, and deletes files under nested keys', async () => {
    await storage.put('originals/shop1/file.pdf', Buffer.from('hello'));
    expect(await storage.exists('originals/shop1/file.pdf')).toBe(true);
    expect((await storage.get('originals/shop1/file.pdf')).toString()).toBe('hello');

    await storage.delete('originals/shop1/file.pdf');
    expect(await storage.exists('originals/shop1/file.pdf')).toBe(false);
  });

  it('treats deleting a missing key as a no-op', async () => {
    await expect(storage.delete('originals/none/missing.pdf')).resolves.toBeUndefined();
  });

  it('overwrites atomically and leaves no temp files behind', async () => {
    await storage.put('a/b.pdf', Buffer.from('one'));
    await storage.put('a/b.pdf', Buffer.from('two'));
    expect((await storage.get('a/b.pdf')).toString()).toBe('two');
    expect(await readdir(join(root, 'a'))).toEqual(['b.pdf']);
  });

  it('moves a local file into storage', async () => {
    const source = join(root, 'incoming.tmp');
    await writeFile(source, 'moved');
    await storage.putFile('moved/x.bin', source);
    expect((await storage.get('moved/x.bin')).toString()).toBe('moved');
    expect(await readdir(root)).not.toContain('incoming.tmp');
  });

  it.each([
    '../escape.pdf',
    'a/../../escape.pdf',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'a\\b.pdf',
    'a//b.pdf',
    '.hidden',
    'a/./b.pdf',
    '',
    'bad key.pdf',
    'a/b.pdf\0',
  ])('rejects unsafe key %j', async (key) => {
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    await expect(storage.get(key)).rejects.toThrow(/Invalid storage key/);
  });
});
