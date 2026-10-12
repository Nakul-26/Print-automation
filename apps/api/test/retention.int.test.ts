import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAudit } from '../src/modules/audit/index.js';
import {
  createRetentionService,
  EVICTION_REASON,
  type DocumentsPort,
  type OrdersPort,
} from '../src/modules/retention/service/retention-service.js';
import { createLogger } from '../src/platform/observability/logger.js';
import { gsAvailable, makePdf } from './fixtures.js';
import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  seedShop,
  type SeededShop,
  type TestContext,
} from './helpers.js';

const settings = {
  pageSelection: 'all',
  copies: 1,
  colorMode: 'black_white',
  sides: 'single',
  paperSize: 'A4',
  pagesPerSheet: 1,
} as const;

const HOUR = 3_600_000;

describe('quota eviction rules', () => {
  const base = new Date('2026-01-01T00:00:00Z');
  const at = (hours: number) => new Date(base.getTime() + hours * HOUR);

  function build(opts: {
    uploads: { uploadId: string; orderId: string | null; createdAt: Date; bytes: number }[];
    printFiles: { orderId: string; status: string; createdAt: Date; bytes: number }[];
    max: number;
  }) {
    const purgedUploads: string[] = [];
    const evictedOrders: string[] = [];
    const documents: DocumentsPort = {
      purgeExpired: async () => ({ count: 0, bytes: 0 }),
      storedUploads: async () => opts.uploads,
      purgeUploads: async (ids) => {
        purgedUploads.push(...ids);
        return { count: ids.length, bytes: 0 };
      },
    };
    const orders: OrdersPort = {
      retire: async () => ({ expired: 0, failed: 0, purgedOrders: 0, bytes: 0 }),
      printFileUsage: async () => opts.printFiles,
      evictFiles: async (ids, reason) => {
        expect(reason).toBe(EVICTION_REASON);
        evictedOrders.push(...ids);
        return { count: ids.length, bytes: 0 };
      },
    };
    const service = createRetentionService({
      documents,
      orders,
      audit: { record: async () => undefined },
      logger: createLogger('silent'),
      maxBytes: () => opts.max,
      highWatermark: 0.9,
      lowWatermark: 0.75,
      stuckProcessingMinutes: 15,
    });
    return { service, purgedUploads, evictedOrders };
  }

  it('does nothing while usage is under the high watermark', async () => {
    const { service, purgedUploads, evictedOrders } = build({
      max: 1000,
      uploads: [{ uploadId: 'u1', orderId: null, createdAt: at(0), bytes: 800 }],
      printFiles: [],
    });
    const result = await service.sweep();
    expect(result.evictedOrders).toBe(0);
    expect(purgedUploads).toEqual([]);
    expect(evictedOrders).toEqual([]);
  });

  it('removes the oldest finished and abandoned files first, and stops under the low watermark', async () => {
    const { service, purgedUploads, evictedOrders } = build({
      max: 1000,
      uploads: [
        { uploadId: 'u-done-old', orderId: 'o-done-old', createdAt: at(1), bytes: 200 },
        { uploadId: 'u-open-oldest', orderId: 'o-open-oldest', createdAt: at(0), bytes: 200 },
        { uploadId: 'u-abandoned', orderId: null, createdAt: at(2), bytes: 200 },
        { uploadId: 'u-done-new', orderId: 'o-done-new', createdAt: at(3), bytes: 200 },
        { uploadId: 'u-open-new', orderId: 'o-open-new', createdAt: at(4), bytes: 200 },
      ],
      printFiles: [
        { orderId: 'o-done-old', status: 'completed', createdAt: at(1), bytes: 50 },
        { orderId: 'o-open-oldest', status: 'pending', createdAt: at(0), bytes: 50 },
        { orderId: 'o-done-new', status: 'rejected', createdAt: at(3), bytes: 50 },
        { orderId: 'o-open-new', status: 'printing', createdAt: at(4), bytes: 50 },
      ],
    });
    // 1200 used of 1000: needs to get to 750, so 450 must go.
    await service.sweep();

    // Finished/abandoned units in age order: done-old (250), abandoned (200) = 450. Open ones untouched.
    expect(purgedUploads.sort()).toEqual(['u-abandoned', 'u-done-old']);
    expect(evictedOrders).toEqual(['o-done-old']);
  });

  it('takes orders that may still be printed only when nothing else is left', async () => {
    const { service, evictedOrders } = build({
      max: 1000,
      uploads: [
        { uploadId: 'u-done', orderId: 'o-done', createdAt: at(5), bytes: 100 },
        { uploadId: 'u-open-old', orderId: 'o-open-old', createdAt: at(0), bytes: 400 },
        { uploadId: 'u-open-new', orderId: 'o-open-new', createdAt: at(1), bytes: 400 },
      ],
      printFiles: [
        { orderId: 'o-done', status: 'completed', createdAt: at(5), bytes: 0 },
        { orderId: 'o-open-old', status: 'accepted', createdAt: at(0), bytes: 0 },
        { orderId: 'o-open-new', status: 'pending', createdAt: at(1), bytes: 0 },
      ],
    });
    // 900 used = exactly the high watermark: not above it, so nothing happens.
    await service.sweep();
    expect(evictedOrders).toEqual([]);

    const bigger = build({
      max: 1000,
      uploads: [
        { uploadId: 'u-done', orderId: 'o-done', createdAt: at(5), bytes: 100 },
        { uploadId: 'u-open-old', orderId: 'o-open-old', createdAt: at(0), bytes: 450 },
        { uploadId: 'u-open-new', orderId: 'o-open-new', createdAt: at(1), bytes: 450 },
      ],
      printFiles: [
        { orderId: 'o-done', status: 'completed', createdAt: at(5), bytes: 0 },
        { orderId: 'o-open-old', status: 'accepted', createdAt: at(0), bytes: 0 },
        { orderId: 'o-open-new', status: 'pending', createdAt: at(1), bytes: 0 },
      ],
    });
    await bigger.service.sweep();
    // 1000 used, target 750: the finished order goes first (100), then the oldest open one (450).
    expect(bigger.purgedUploads.sort()).toEqual(['u-done', 'u-open-old']);
    expect(bigger.evictedOrders.sort()).toEqual(['o-done', 'o-open-old']);
  });
});

describe('retention with real files', () => {
  let ctx: TestContext;
  let gsOk = false;
  let shop: SeededShop;
  const SLUG = 'alpha-prints';

  beforeAll(async () => {
    gsOk = await gsAvailable();
    ctx = createTestContext();
    await ctx.container.start();
  });
  afterAll(() => ctx.close());
  beforeEach(async () => {
    await resetDatabase(ctx.db);
    shop = await seedShop(ctx, 'Alpha Prints', SLUG);
  });

  const gsIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (t) => {
      if (!gsOk) t.skip();
      await fn();
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(check: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function uploadPdf(pages = 3) {
    const up = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/uploads`)
      .attach('file', await makePdf(pages), {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      });
    expect(up.status).toBe(201);
    await waitFor(async () => {
      const r = await request(ctx.app).get(`/api/v1/uploads/${up.body.token}`);
      return r.body.status === 'ready';
    }, 'upload to be ready');
    return up.body.token as string;
  }

  async function placeOrder(pages = 3) {
    const token = await uploadPdf(pages);
    const res = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/orders`)
      .send({ customerName: 'Asha', items: [{ uploadToken: token, settings }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const lookupToken = res.body.lookupToken as string;
    await waitFor(async () => {
      const r = await request(ctx.app).get(`/api/v1/orders/${lookupToken}`);
      return r.body.status === 'pending';
    }, 'order to become pending');
    const row = await ctx.db.order.findFirstOrThrow({
      where: { lookupTokenHash: { not: '' } },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
    return {
      lookupToken,
      orderId: row.id,
      itemId: row.items[0]!.id,
      uploadId: row.items[0]!.uploadId,
    };
  }

  const age = (orderId: string, hours: number) =>
    ctx.db.order.update({
      where: { id: orderId },
      data: { expiresAt: new Date(Date.now() - hours * HOUR) },
    });

  const storage = () => ctx.container.storage;

  gsIt('expires an open order after its time and deletes every file', async () => {
    const { lookupToken, orderId, uploadId } = await placeOrder();
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId } });
    const upload = await ctx.db.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(await storage().exists(item.printPdfKey!)).toBe(true);
    expect(await storage().exists(upload.originalKey!)).toBe(true);

    await age(orderId, 1);
    await ctx.db.upload.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - HOUR) },
    });
    const result = await ctx.container.retention.sweep();
    expect(result.expiredOrders).toBe(1);

    expect(await storage().exists(item.printPdfKey!)).toBe(false);
    expect(await storage().exists(upload.originalKey!)).toBe(false);
    expect(await storage().exists(upload.normalizedKey!)).toBe(false);

    const student = await request(ctx.app).get(`/api/v1/orders/${lookupToken}`);
    expect(student.body.status).toBe('expired');
    // The record of the order stays; only the files are gone.
    expect(student.body.items[0].originalName).toBe('notes.pdf');

    const fresh = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(fresh.filesPurgedAt).not.toBeNull();
    const purgedItem = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId } });
    expect(purgedItem.printPdfKey).toBeNull();
  });

  gsIt('keeps a completed order in the history but deletes its files', async () => {
    const { orderId, uploadId } = await placeOrder();
    const agent = request.agent(ctx.app);
    await agent.post('/api/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD });
    const base = `/api/v1/owner/shops/${shop.shopId}/orders/${orderId}`;
    await agent.post(`${base}/actions`).send({ action: 'print' });
    await agent.post(`${base}/actions`).send({ action: 'complete', finalAmountPaise: 700 });

    await age(orderId, 2);
    await ctx.db.upload.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - HOUR) },
    });
    await ctx.container.retention.sweep();

    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('completed');
    expect(order.finalAmountPaise).toBe(700);
    expect(order.filesPurgedAt).not.toBeNull();

    const queue = await agent.get(`/api/v1/owner/shops/${shop.shopId}/orders`);
    expect(queue.body.orders[0].items[0].fileReady).toBe(false);
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId } });
    const file = await agent.get(`${base}/items/${item.id}/file`);
    expect(file.status).toBe(404);
  });

  gsIt('deletes an upload that was never ordered once it expires', async () => {
    const token = await uploadPdf();
    const row = await ctx.db.upload.findFirstOrThrow();
    await ctx.db.upload.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - HOUR) },
    });
    const result = await ctx.container.retention.sweep();
    expect(result.purgedUploads).toBe(1);
    expect(await storage().exists(row.originalKey!)).toBe(false);
    expect(await ctx.db.upload.count()).toBe(0);
    expect((await request(ctx.app).get(`/api/v1/uploads/${token}`)).status).toBe(404);
  });

  gsIt('fails an order that never finished preparing', async () => {
    const { lookupToken, orderId } = await placeOrder();
    await ctx.db.order.update({
      where: { id: orderId },
      data: { status: 'processing', createdAt: new Date(Date.now() - HOUR) },
    });
    const result = await ctx.container.retention.sweep();
    expect(result.failedOrders).toBe(1);
    expect((await request(ctx.app).get(`/api/v1/orders/${lookupToken}`)).body.status).toBe(
      'failed',
    );
  });

  gsIt('leaves fresh orders alone', async () => {
    const { orderId } = await placeOrder();
    const result = await ctx.container.retention.sweep();
    expect(result).toMatchObject({ expiredOrders: 0, purgedUploads: 0, evictedOrders: 0 });
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId } });
    expect(await storage().exists(item.printPdfKey!)).toBe(true);
  });

  gsIt('under storage pressure removes the oldest finished order before open ones', async () => {
    const first = await placeOrder(4);
    const second = await placeOrder(4);
    const third = await placeOrder(4);

    // The first order is finished; the other two are still waiting.
    const agent = request.agent(ctx.app);
    await agent.post('/api/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD });
    const base = `/api/v1/owner/shops/${shop.shopId}/orders/${first.orderId}`;
    await agent.post(`${base}/actions`).send({ action: 'print' });
    await agent.post(`${base}/actions`).send({ action: 'complete' });

    // Pretend the disk limit is just above what is stored now, so one order has to go.
    const usage = [
      ...(await ctx.container.documents.api.storedUploads()),
      ...(await ctx.container.orders.api.printFileUsage()),
    ].reduce((sum, u) => sum + u.bytes, 0);
    const service = createRetentionService({
      documents: ctx.container.documents.api,
      orders: ctx.container.orders.api,
      audit: createAudit({ db: ctx.db, logger: createLogger('silent') }),
      logger: createLogger('silent'),
      maxBytes: () => Math.floor(usage / 0.95),
      highWatermark: 0.9,
      lowWatermark: 0.75,
      stuckProcessingMinutes: 15,
    });
    const result = await service.sweep();
    expect(result.evictedOrders).toBe(1);

    const purged = async (id: string) =>
      (await ctx.db.order.findUniqueOrThrow({ where: { id } })).filesPurgedAt !== null;
    expect(await purged(first.orderId)).toBe(true);
    expect(await purged(second.orderId)).toBe(false);
    expect(await purged(third.orderId)).toBe(false);
    // The finished order keeps its status; the open ones are untouched and still printable.
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: first.orderId } })).status).toBe(
      'completed',
    );
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: second.orderId } })).status).toBe(
      'pending',
    );
    const audit = await ctx.db.auditLog.findFirst({ where: { action: 'order.files_evicted' } });
    expect(audit?.entityId).toBe(first.orderId);
  });
});
