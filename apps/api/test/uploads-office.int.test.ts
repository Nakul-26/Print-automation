import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_OFFICE,
  makeDocx,
  makePng,
  makePptx,
  officeAvailable,
  pdfInfo,
} from './fixtures.js';
import { createTestContext, resetDatabase, seedShop, type TestContext } from './helpers.js';

const SLUG = 'alpha-prints';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

let ctx: TestContext;
let officeOk = false;

beforeAll(async () => {
  officeOk = await officeAvailable();
  if (!officeOk) console.warn('LibreOffice unavailable; skipping Office upload tests');
  ctx = createTestContext();
  await ctx.container.start();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx.db);
});

const officeIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (t) => {
    if (!officeOk) t.skip();
    await fn();
  });

function upload(context: TestContext, file: Buffer, filename: string, contentType: string) {
  return request(context.app)
    .post(`/api/v1/shops/${SLUG}/uploads`)
    .attach('file', file, { filename, contentType });
}

async function settle(context: TestContext, token: string) {
  for (let i = 0; i < 150; i++) {
    const res = await request(context.app).get(`/api/v1/uploads/${token}`);
    if (res.body.status !== 'processing') return res;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('upload did not finish processing');
}

function changeSettings(context: TestContext, token: string, settings: unknown) {
  return request(context.app).post(`/api/v1/uploads/${token}/conversion`).send({ settings });
}

async function previewInfo(context: TestContext, token: string) {
  const res = await request(context.app)
    .get(`/api/v1/uploads/${token}/preview`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return pdfInfo(res.body as Buffer);
}

describe('Office uploads', () => {
  officeIt('converts a Word document and lets the student change the settings', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makeDocx(), 'essay.docx', DOCX);
    expect(created.status).toBe(201);
    expect(created.body.upload).toMatchObject({
      documentKind: 'office',
      officeFamily: 'writer',
      conversionSettings: { paperSize: 'A4', orientation: 'auto', margins: 'document' },
      revision: 0,
    });
    const token: string = created.body.token;

    const first = await settle(ctx, token);
    expect(first.body.status).toBe('ready');
    const a4Pages: number = first.body.pageCount;
    expect(a4Pages).toBeGreaterThanOrEqual(2);
    expect((await previewInfo(ctx, token)).sizes[0]).toBe('595x842');

    // Change to A3: a new conversion runs.
    const change = await changeSettings(ctx, token, {
      paperSize: 'A3',
      orientation: 'auto',
      margins: 'document',
    });
    expect(change.status).toBe(200);
    expect(change.body).toMatchObject({ status: 'processing', revision: 1 });

    const second = await settle(ctx, token);
    expect(second.body).toMatchObject({ status: 'ready', revision: 1 });
    expect(second.body.conversionSettings.paperSize).toBe('A3');
    expect(second.body.pageCount).toBeLessThan(a4Pages);
    expect((await previewInfo(ctx, token)).sizes[0]).toBe('842x1191');

    // Back to A4: that variant already exists, so it switches instantly with no new job.
    const back = await changeSettings(ctx, token, {
      paperSize: 'A4',
      orientation: 'auto',
      margins: 'document',
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'ready', revision: 1, pageCount: a4Pages });
    expect((await previewInfo(ctx, token)).sizes[0]).toBe('595x842');
  });

  officeIt('applies defaults for omitted settings and rejects invalid ones', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makeDocx(20), 'a.docx', DOCX);
    const token: string = created.body.token;
    await settle(ctx, token);

    // Slide options make no sense for a Word document, and unknown values are refused.
    expect((await changeSettings(ctx, token, { includeNotes: true })).status).toBe(400);
    expect((await changeSettings(ctx, token, { paperSize: 'Letter' })).status).toBe(400);
    expect((await changeSettings(ctx, token, { margins: 'huge' })).status).toBe(400);
    const noBody = await request(ctx.app).post(`/api/v1/uploads/${token}/conversion`).send({});
    expect(noBody.status).toBe(400);

    const ok = await changeSettings(ctx, token, { orientation: 'landscape' });
    expect(ok.status).toBe(200);
    expect(ok.body.conversionSettings).toEqual({
      paperSize: 'A4',
      orientation: 'landscape',
      margins: 'document',
    });
  });

  officeIt('offers slide options for presentations', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makePptx(), 'deck.pptx', PPTX);
    expect(created.body.upload.officeFamily).toBe('impress');
    const token: string = created.body.token;
    const first = await settle(ctx, token);
    expect(first.body.pageCount).toBe(2); // one slide is hidden

    const change = await changeSettings(ctx, token, { includeHiddenSlides: true });
    expect(change.status).toBe(200);
    expect((await settle(ctx, token)).body.pageCount).toBe(3);
  });

  officeIt('does not allow changes while converting, or on non-Office uploads', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makeDocx(), 'a.docx', DOCX);
    const busy = await changeSettings(ctx, created.body.token, { paperSize: 'A3' });
    expect(busy.status).toBe(409);
    await settle(ctx, created.body.token);

    const png = await upload(ctx, await makePng(), 'a.png', 'image/png');
    const notOffice = await changeSettings(ctx, png.body.token, {});
    expect(notOffice.status).toBe(400);
    expect(notOffice.body.error.code).toBe('not_convertible');
  });

  officeIt('keeps the previous preview when a settings change cannot be converted', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makeDocx(), 'a.docx', DOCX);
    const token: string = created.body.token;
    const first = await settle(ctx, token);

    // Run the next conversion on a worker whose converter is broken.
    await ctx.container.stop();
    const broken = createTestContext({
      STORAGE_ROOT: ctx.storageRoot,
      OFFICE_COMMAND: 'definitely-not-a-real-command',
    });
    try {
      await broken.container.start();
      const change = await changeSettings(broken, token, { paperSize: 'A3' });
      expect(change.status).toBe(200);
      const after = await settle(broken, token);

      expect(after.body.status).toBe('ready'); // still usable
      expect(after.body.errorMessage).toMatch(/could not be applied/i);
      expect(after.body.conversionSettings.paperSize).toBe('A4'); // reverted
      expect(after.body.pageCount).toBe(first.body.pageCount);
      expect((await previewInfo(broken, token)).sizes[0]).toBe('595x842');
    } finally {
      await broken.close();
      await ctx.container.start();
    }
  });

  officeIt('deletes every converted variant when the student discards the upload', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const created = await upload(ctx, await makeDocx(), 'a.docx', DOCX);
    const token: string = created.body.token;
    await settle(ctx, token);
    await changeSettings(ctx, token, { paperSize: 'A3' });
    await settle(ctx, token);

    const row = await ctx.db.upload.findFirstOrThrow();
    const variants = row.conversionVariants as Record<string, { key: string }>;
    const keys = [row.originalKey!, ...Object.values(variants).map((v) => v.key)];
    expect(keys).toHaveLength(3); // original + A4 + A3
    for (const key of keys) expect(await ctx.container.storage.exists(key)).toBe(true);

    expect((await request(ctx.app).delete(`/api/v1/uploads/${token}`)).status).toBe(204);
    for (const key of keys) expect(await ctx.container.storage.exists(key)).toBe(false);
  });

  officeIt('marks a damaged Word file as failed and removes its files', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const good = await makeDocx(5);
    // Cut off the end: the type is still recognisable but LibreOffice cannot open it.
    const damaged = good.subarray(0, Math.floor(good.length * 0.6));
    const created = await upload(ctx, damaged, 'bad.docx', DOCX);
    if (created.status === 415) return; // too damaged to even identify: also a rejection
    const done = await settle(ctx, created.body.token);
    expect(done.body).toMatchObject({ status: 'failed', errorCode: 'corrupt_file' });
    const row = await ctx.db.upload.findFirstOrThrow();
    expect(row.originalKey).toBeNull();
  });
});

describe('legacy Office files', () => {
  it('are rejected with advice to re-save as a modern format', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await upload(ctx, LEGACY_OFFICE, 'old.doc', 'application/msword');
    expect(res.status).toBe(415);
    expect(res.body.error.message).toMatch(/\.docx/);
    const tmp = await readdir(join(ctx.storageRoot, 'tmp')).catch(() => []);
    expect(tmp).toEqual([]);
  });
});
