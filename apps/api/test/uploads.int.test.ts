import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CORRUPT_PDF,
  FAKE_EXE,
  gsAvailable,
  makeEncryptedPdf,
  makePdf,
  makePng,
  makeRotatedJpeg,
  pdfInfo,
} from './fixtures.js';
import { createTestContext, resetDatabase, seedShop, type TestContext } from './helpers.js';

const SLUG = 'alpha-prints';
let ctx: TestContext;
let gsOk = false;

beforeAll(async () => {
  gsOk = await gsAvailable();
  ctx = createTestContext();
  await ctx.container.start();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx.db);
});

function upload(
  context: TestContext,
  file: Buffer,
  filename = 'doc.pdf',
  slug = SLUG,
  contentType = 'application/pdf',
) {
  return request(context.app)
    .post(`/api/v1/shops/${slug}/uploads`)
    .attach('file', file, { filename, contentType });
}

async function settle(context: TestContext, token: string) {
  for (let i = 0; i < 100; i++) {
    const res = await request(context.app).get(`/api/v1/uploads/${token}`);
    if (res.body.status !== 'processing') return res;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('upload did not finish processing');
}

const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (t) => {
    if (!gsOk) t.skip();
    await fn();
  });

async function tempFiles(context: TestContext): Promise<string[]> {
  try {
    return await readdir(join(context.storageRoot, 'tmp'));
  } catch {
    return [];
  }
}

describe('PDF uploads', () => {
  gsIt('accepts a PDF, processes it, and serves a preview', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePdf(3), 'assignment.pdf');

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.body.upload.status).toBe('processing');
    expect(res.body.upload.originalName).toBe('assignment.pdf');

    const done = await settle(ctx, res.body.token);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'ready', pageCount: 3, errorCode: null });

    const preview = await request(ctx.app)
      .get(`/api/v1/uploads/${res.body.token}/preview`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(preview.status).toBe(200);
    expect(preview.headers['content-type']).toBe('application/pdf');
    expect(preview.headers['cache-control']).toContain('no-store');
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
    expect((await pdfInfo(preview.body as Buffer)).count).toBe(3);
  });

  it('stores only a hash of the token and never uses the client filename on disk', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), '../../etc/evil name.png', SLUG, 'image/png');
    expect(res.status).toBe(201);
    expect(res.body.upload.originalName).toBe('evil name.png');

    const row = await ctx.db.upload.findFirstOrThrow();
    expect(row.tokenHash).not.toContain(res.body.token);
    expect(row.originalKey).toMatch(/^originals\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect(row.originalName).toBe('evil name.png');
  });

  it('sets the expiry from the retention period (24 hours)', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), 'a.png', SLUG, 'image/png');
    const hours =
      (new Date(res.body.upload.expiresAt).getTime() -
        new Date(res.body.upload.createdAt).getTime()) /
      3_600_000;
    expect(hours).toBeCloseTo(24, 1);
  });
});

describe('image uploads', () => {
  it('converts a phone photo into an upright one-page PDF', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makeRotatedJpeg(), 'IMG_0001.jpg', SLUG, 'image/jpeg');
    expect(res.status).toBe(201);
    const done = await settle(ctx, res.body.token);
    expect(done.body).toMatchObject({ status: 'ready', pageCount: 1 });
  });
});

describe('rejections', () => {
  it('rejects an executable renamed to .pdf, by content', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, FAKE_EXE, 'invoice.pdf');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_type');
    expect(await tempFiles(ctx)).toEqual([]);
    expect(await ctx.db.upload.count()).toBe(0);
  });

  it('rejects plain text and empty files', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    expect((await upload(ctx, Buffer.from('hello there'), 'notes.pdf')).status).toBe(415);
    expect((await upload(ctx, Buffer.alloc(0), 'empty.pdf')).status).toBe(400);
    expect(await tempFiles(ctx)).toEqual([]);
  });

  it('rejects requests without a file', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await request(ctx.app).post(`/api/v1/shops/${SLUG}/uploads`).field('x', 'y');
    expect(res.status).toBe(400);
  });

  it('rejects oversized files with 413 and leaves nothing behind', async () => {
    const small = createTestContext({ MAX_UPLOAD_BYTES: '2000' });
    try {
      await seedShop(small, 'Alpha Prints', SLUG);
      const big = await makePdf(80);
      expect(big.length).toBeGreaterThan(2000);
      const res = await upload(small, big, 'big.pdf');
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('too_large');
      expect(await tempFiles(small)).toEqual([]);
    } finally {
      await small.close();
    }
  });

  it('hides unknown, pending, and suspended shops behind the same 404', async () => {
    await seedShop(ctx, 'Pending Shop', 'pending-shop', { status: 'pending_approval' });
    await seedShop(ctx, 'Gone Shop', 'gone-shop', { status: 'suspended' });
    const pdf = await makePdf(1);
    for (const slug of ['no-such-shop', 'pending-shop', 'gone-shop']) {
      const res = await upload(ctx, pdf, 'a.pdf', slug);
      expect(res.status).toBe(404);
    }
    expect(await tempFiles(ctx)).toEqual([]);
  });

  gsIt('marks damaged PDFs as failed, with a friendly message and no files kept', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, CORRUPT_PDF, 'broken.pdf');
    expect(res.status).toBe(201);
    const done = await settle(ctx, res.body.token);
    expect(done.body.status).toBe('failed');
    expect(done.body.errorMessage).toMatch(/could not be read/i);
    expect(done.body.errorMessage).not.toMatch(/ghostscript|stack|error:/i);

    const row = await ctx.db.upload.findFirstOrThrow();
    expect(row.originalKey).toBeNull();
    expect(row.filesPurgedAt).not.toBeNull();
    expect(await readdir(join(ctx.storageRoot, 'originals', row.shopId)).catch(() => [])).toEqual(
      [],
    );
  });

  gsIt('marks password-protected PDFs as failed with encrypted_pdf', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makeEncryptedPdf(), 'locked.pdf');
    const done = await settle(ctx, res.body.token);
    expect(done.body).toMatchObject({ status: 'failed', errorCode: 'encrypted_pdf' });
  });

  gsIt('enforces the page limit', async () => {
    // Jobs go to whichever worker polls first, so run only this context's worker.
    await ctx.container.stop();
    const limited = createTestContext({ MAX_PDF_PAGES: '3' });
    try {
      await limited.container.start();
      await seedShop(limited, 'Alpha Prints', SLUG);
      const res = await upload(limited, await makePdf(4), 'long.pdf');
      const done = await settle(limited, res.body.token);
      expect(done.body).toMatchObject({ status: 'failed', errorCode: 'too_many_pages' });
    } finally {
      await limited.close();
      await ctx.container.start();
    }
  });

  it('refuses new uploads when the storage limit is reached', async () => {
    const full = createTestContext({ STORAGE_MAX_BYTES: '100' });
    try {
      await seedShop(full, 'Alpha Prints', SLUG);
      const res = await upload(full, await makePng(), 'a.png', SLUG, 'image/png');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('storage_full');
      expect(await tempFiles(full)).toEqual([]);
    } finally {
      await full.close();
    }
  });

  it('rate-limits repeated uploads', async () => {
    const limited = createTestContext({
      UPLOAD_RATE_LIMIT_MAX: '2',
      STORAGE_ROOT: ctx.storageRoot,
    });
    try {
      await limited.container.start();
      await seedShop(limited, 'Alpha Prints', SLUG);
      const png = await makePng();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await upload(limited, png, 'a.png', SLUG, 'image/png')).status);
      }
      expect(statuses).toEqual([201, 201, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('access by token', () => {
  it('returns 404 for malformed and unknown tokens', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    for (const token of ['short', 'x'.repeat(40), 'A'.repeat(32), '../../etc/passwd']) {
      expect(
        (await request(ctx.app).get(`/api/v1/uploads/${encodeURIComponent(token)}`)).status,
      ).toBe(404);
    }
    expect((await request(ctx.app).get(`/api/v1/uploads/${'A'.repeat(32)}/preview`)).status).toBe(
      404,
    );
  });

  it('does not allow another upload to be reached by changing one character', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), 'a.png', SLUG, 'image/png');
    const t: string = res.body.token;
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    expect((await request(ctx.app).get(`/api/v1/uploads/${tampered}`)).status).toBe(404);
  });

  it('treats expired uploads as missing', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), 'a.png', SLUG, 'image/png');
    await ctx.db.upload.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(ctx.app).get(`/api/v1/uploads/${res.body.token}`)).status).toBe(404);
  });

  it('only previews uploads that are ready', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), 'a.png', SLUG, 'image/png');
    await ctx.db.upload.updateMany({ data: { status: 'processing', normalizedKey: null } });
    const preview = await request(ctx.app).get(`/api/v1/uploads/${res.body.token}/preview`);
    expect(preview.status).toBe(409);
  });

  it('lets the student discard an upload, deleting its files at once', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, await makePng(), 'a.png', SLUG, 'image/png');
    await settle(ctx, res.body.token);
    const row = await ctx.db.upload.findFirstOrThrow();
    expect(await ctx.container.storage.exists(row.originalKey!)).toBe(true);
    expect(await ctx.container.storage.exists(row.normalizedKey!)).toBe(true);

    expect((await request(ctx.app).delete(`/api/v1/uploads/${res.body.token}`)).status).toBe(204);
    expect(await ctx.container.storage.exists(row.originalKey!)).toBe(false);
    expect(await ctx.container.storage.exists(row.normalizedKey!)).toBe(false);
    expect((await request(ctx.app).get(`/api/v1/uploads/${res.body.token}`)).status).toBe(404);
  });
});
