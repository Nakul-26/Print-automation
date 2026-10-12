import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gsAvailable, makePdf } from './fixtures.js';
import { createTestContext, resetDatabase, seedShop, type TestContext } from './helpers.js';

const SLUG = 'alpha-prints';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let gsOk = false;
beforeAll(async () => {
  gsOk = await gsAvailable();
});

const upload = async (ctx: TestContext, pages = 2) => {
  const res = await request(ctx.app)
    .post(`/api/v1/shops/${SLUG}/uploads`)
    .attach('file', await makePdf(pages), { filename: 'doc.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  return res.body as { token: string; upload: { queueAhead: number | null } };
};

const view = async (ctx: TestContext, token: string) =>
  (await request(ctx.app).get(`/api/v1/uploads/${token}`)).body;

describe('separate web and worker processes', () => {
  let web: TestContext;
  let worker: TestContext;
  let storageRoot: string;

  beforeAll(async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'print-scale-'));
    web = createTestContext({ APP_ROLE: 'api', STORAGE_ROOT: storageRoot });
    worker = createTestContext({ APP_ROLE: 'worker', STORAGE_ROOT: storageRoot });
    await web.container.start();
  });
  afterAll(async () => {
    await worker.close();
    await web.close();
    rmSync(storageRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(web.db);
    await seedShop(web, 'Alpha Prints', SLUG);
  });

  it('queues uploads in the web process and tells students how many are ahead', async (t) => {
    if (!gsOk) t.skip();
    const first = await upload(web);
    const second = await upload(web);
    expect(first.upload.queueAhead).toBe(0);
    expect(second.upload.queueAhead).toBe(1);

    // No worker is running yet: nothing is processed by the web process.
    await sleep(1500);
    expect((await view(web, first.token)).status).toBe('processing');
    expect((await view(web, second.token)).queueAhead).toBe(1);

    // A worker process picks the jobs up; both finish and the position goes away.
    await worker.container.start();
    for (const { token } of [first, second]) {
      let body = await view(web, token);
      for (let i = 0; i < 100 && body.status === 'processing'; i++) {
        await sleep(150);
        body = await view(web, token);
      }
      expect(body).toMatchObject({ status: 'ready', queueAhead: null, pageCount: 2 });
    }
  });

  it('delivers realtime events from the worker to browsers connected to the web process', async () => {
    const server: Server = createServer(web.app);
    web.container.realtime.handle('test:join', (client, payload) => {
      client.join((payload as { room: string }).room);
    });
    web.container.realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const socket: Socket = connect(url, { transports: ['websocket'], reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      await new Promise((resolve) => socket.emit('test:join', { room: 'room-1' }, resolve));

      worker.container.realtime.attachEmitterOnly();
      const received = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('event never arrived')), 5000);
        socket.once('ping-from-worker', (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });
      await sleep(300); // let the worker's adapter start listening
      worker.container.realtime.emit('room-1', 'ping-from-worker', { n: 1 });
      expect(await received).toEqual({ n: 1 });
    } finally {
      socket.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('preview admission control', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = createTestContext({ PREVIEW_CONCURRENCY: '1', PREVIEW_MAX_WAITING: '0' });
    await ctx.container.start();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDatabase(ctx.db);
    await seedShop(ctx, 'Alpha Prints', SLUG);
  });

  it('answers 503 with Retry-After instead of queueing without limit', async (t) => {
    if (!gsOk) t.skip();
    const { token } = await upload(ctx);
    for (let i = 0; i < 100 && (await view(ctx, token)).status === 'processing'; i++) {
      await sleep(150);
    }
    const body = {
      uploadToken: token,
      settings: {
        pageSelection: 'all',
        copies: 1,
        colorMode: 'black_white',
        sides: 'single',
        paperSize: 'A4',
        pagesPerSheet: 1,
      },
    };

    // Occupy the only slot, as a slow preview from another student would.
    let release!: () => void;
    const held = ctx.container.previewGate.run(() => new Promise<void>((r) => (release = r)));
    const busy = await request(ctx.app).post(`/api/v1/shops/${SLUG}/print-preview`).send(body);
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe('busy');
    expect(busy.headers['retry-after']).toBe('3');

    release();
    await held;
    const ok = await request(ctx.app).post(`/api/v1/shops/${SLUG}/print-preview`).send(body);
    expect(ok.status).toBe(200);
  });
});

describe('storage accounting', () => {
  it('counts every stored byte exactly (database sum matches the files on record)', async (t) => {
    if (!gsOk) t.skip();
    const probe = createTestContext();
    await probe.container.start();
    try {
      await resetDatabase(probe.db);
      await seedShop(probe, 'Alpha Prints', SLUG);
      const { token } = await upload(probe, 3);
      for (let i = 0; i < 100 && (await view(probe, token)).status === 'processing'; i++) {
        await sleep(150);
      }
      const used = (await probe.container.documents.api.storedUploads()).reduce(
        (sum, u) => sum + u.bytes,
        0,
      );
      expect(used).toBeGreaterThan(0);

      const pdf = await makePdf(1);
      const attempt = async (ctx: TestContext) =>
        request(ctx.app)
          .post(`/api/v1/shops/${SLUG}/uploads`)
          .attach('file', pdf, { filename: 'b.pdf', contentType: 'application/pdf' });

      // The limit check is used + 2 x new size > max, so the exact boundary reveals the sum.
      const tooSmall = createTestContext({ STORAGE_MAX_BYTES: String(used + pdf.length * 2 - 1) });
      const justEnough = createTestContext({ STORAGE_MAX_BYTES: String(used + pdf.length * 2) });
      try {
        await tooSmall.container.start();
        await justEnough.container.start();
        expect((await attempt(tooSmall)).status).toBe(503);
        expect((await attempt(justEnough)).status).toBe(201);
      } finally {
        await tooSmall.close();
        await justEnough.close();
      }
    } finally {
      await probe.close();
    }
  });
});
