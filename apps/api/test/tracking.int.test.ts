import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  seedShop,
  type SeededShop,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = createTestContext();
  await ctx.container.start();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx.db);
});

/** The shop-local date the way the platform computes it (everything runs on Indian time). */
const dateKey = (offsetDays = 0): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() - offsetDays * 86_400_000));

let counter = 0;

/** Inserts an order (with one document of `sides` printed sides) without going through the upload flow. */
async function seedOrder(
  shopId: string,
  opts: {
    status?: 'pending' | 'printing' | 'completed' | 'rejected' | 'expired';
    amountPaise?: number;
    sides?: number;
    daysAgo?: number;
    /** An online payment: paid, refunded, refund_failed or still awaiting. */
    online?: {
      state: 'paid' | 'refunded' | 'refund_failed' | 'awaiting';
      method?: string;
      amountPaise?: number;
    };
  } = {},
) {
  counter += 1;
  const amount = opts.amountPaise ?? 600;
  const upload = await ctx.db.upload.create({
    data: {
      shopId,
      tokenHash: randomUUID(),
      originalName: 'notes.pdf',
      detectedMime: 'application/pdf',
      sizeBytes: 1000,
      contentSha256: 'x',
      status: 'ready',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const online = opts.online;
  return ctx.db.order.create({
    data: {
      shopId,
      queueDate: dateKey(opts.daysAgo ?? 0),
      queueNumber: counter,
      lookupTokenHash: randomUUID(),
      status: opts.status ?? 'completed',
      estimatedAmountPaise: amount,
      finalAmountPaise: opts.status === 'completed' || opts.status === undefined ? amount : null,
      rateSnapshot: {},
      expiresAt: new Date(Date.now() + 3_600_000),
      ...(online
        ? {
            paymentState: online.state,
            ...(online.state !== 'awaiting'
              ? {
                  paymentMethod: online.method ?? 'upi',
                  paidAmountPaise: online.amountPaise ?? amount,
                  paidAt: new Date(),
                }
              : {}),
          }
        : {}),
      items: {
        create: {
          shopId,
          uploadId: upload.id,
          position: 0,
          originalName: 'notes.pdf',
          pageCount: opts.sides ?? 3,
          printSettings: {},
          selectedPages: [],
          selectedPageCount: opts.sides ?? 3,
          printedSides: opts.sides ?? 3,
          sheets: 1,
          amountPaise: amount,
          sourceKey: 'k',
        },
      },
    },
  });
}

async function signIn(shop: SeededShop) {
  const agent = request.agent(ctx.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: shop.ownerEmail, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

async function adminAgent() {
  await ctx.container.identity.users.create({
    email: 'root@example.com',
    name: 'Root',
    password: PASSWORD,
    platformRole: 'platform_admin',
  });
  const agent = request.agent(ctx.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: 'root@example.com', password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe("the shop's daily summary", () => {
  it('adds up today only: online money by method, what is still to collect at the counter, and failed refunds', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(shop);
    await seedOrder(shop.shopId, {
      amountPaise: 500,
      sides: 10,
      online: { state: 'paid', method: 'upi' },
    });
    await seedOrder(shop.shopId, {
      amountPaise: 300,
      sides: 4,
      online: { state: 'paid', method: 'card' },
    });
    await seedOrder(shop.shopId, { amountPaise: 200, sides: 2 }); // printed, paid at the counter
    await seedOrder(shop.shopId, {
      status: 'rejected',
      sides: 50,
      online: { state: 'refunded', amountPaise: 700 },
    });
    await seedOrder(shop.shopId, {
      status: 'rejected',
      sides: 5,
      online: { state: 'refund_failed', amountPaise: 100 },
    });
    await seedOrder(shop.shopId, {
      daysAgo: 1,
      amountPaise: 9999,
      sides: 99,
      online: { state: 'paid', method: 'upi' },
    });

    const res = await agent.get(`/api/v1/owner/shops/${shop.shopId}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      date: dateKey(),
      orders: 5,
      printed: 3,
      rejected: 2,
      pages: 16,
      // refunded money is not collected; the failed refund is flagged
      collectedPaise: 800,
      counterCount: 1,
      counterPaise: 200,
      refundFailed: 1,
    });
    expect(res.body.byMethod).toEqual([
      { method: 'card', count: 1, amountPaise: 300 },
      { method: 'upi', count: 1, amountPaise: 500 },
    ]);
  });

  it('never counts or shows an order whose online payment has not arrived', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(shop);
    await seedOrder(shop.shopId, { status: 'pending', online: { state: 'awaiting' } });
    await seedOrder(shop.shopId, { status: 'pending' });

    const summary = (await agent.get(`/api/v1/owner/shops/${shop.shopId}/summary`)).body;
    expect(summary.orders).toBe(1);
    const queue = (await agent.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).body.orders;
    expect(queue).toHaveLength(1);

    const admin = await adminAgent();
    const list = await admin.get('/api/v1/admin/shops');
    const a = list.body.shops.find((s: { id: string }) => s.id === shop.shopId);
    expect(a.stats30.orders).toBe(1);
    expect(a.totalOrders).toBe(1);
    const detail = await admin.get(`/api/v1/admin/shops/${shop.shopId}`);
    expect(detail.body.recent).toHaveLength(1);
  });

  it('is private to the shop and needs sign-in', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    await seedOrder(beta.shopId, { amountPaise: 400, online: { state: 'paid' } });
    const agent = await signIn(alpha);

    expect((await agent.get(`/api/v1/owner/shops/${beta.shopId}/summary`)).status).toBe(404);
    const own = await agent.get(`/api/v1/owner/shops/${alpha.shopId}/summary`);
    expect(own.body).toMatchObject({ orders: 0, collectedPaise: 0 });
    expect((await request(ctx.app).get(`/api/v1/owner/shops/${alpha.shopId}/summary`)).status).toBe(
      401,
    );
  });
});

describe('the platform admin view of shops', () => {
  it('shows each shop’s last 30 days, and an overview that adds the shops up', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    await seedOrder(alpha.shopId, {
      amountPaise: 500,
      sides: 10,
      online: { state: 'paid', method: 'upi' },
    });
    await seedOrder(alpha.shopId, {
      daysAgo: 3,
      amountPaise: 300,
      sides: 5,
      online: { state: 'paid', method: 'card' },
    });
    await seedOrder(alpha.shopId, {
      daysAgo: 40,
      amountPaise: 8000,
      sides: 80,
      online: { state: 'paid', method: 'upi' },
    });
    await seedOrder(beta.shopId, { amountPaise: 200, sides: 2 });
    const admin = await adminAgent();

    const list = await admin.get('/api/v1/admin/shops');
    const a = list.body.shops.find((s: { slug: string }) => s.slug === 'alpha-prints');
    const b = list.body.shops.find((s: { slug: string }) => s.slug === 'beta-prints');
    expect(a.stats30).toMatchObject({
      orders: 2,
      printed: 2,
      pages: 15,
      collectedPaise: 800,
      counterCount: 0,
      refundFailed: 0,
    });
    expect(b.stats30).toMatchObject({
      orders: 1,
      collectedPaise: 0,
      counterCount: 1,
      counterPaise: 200,
    });
    expect(a.printingOnline).toBe(false);

    const overview = await admin.get('/api/v1/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.shops).toMatchObject({ active: 2, pending: 0, suspended: 0 });
    expect(overview.body.today).toMatchObject({ orders: 2, pages: 12, collectedPaise: 500 });
    expect(overview.body.last30).toMatchObject({ orders: 3, pages: 17, collectedPaise: 800 });
    expect(overview.body.daily).toHaveLength(30);
    expect(overview.body.daily[29]).toMatchObject({ date: dateKey(), orders: 2 });
    expect(overview.body.byMethod30).toEqual([
      { method: 'card', count: 1, amountPaise: 300 },
      { method: 'upi', count: 1, amountPaise: 500 },
    ]);
  });

  it('gives one shop in depth without student names, and keeps private notes out of the owner’s reach', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await seedOrder(shop.shopId, {
      amountPaise: 500,
      sides: 10,
      online: { state: 'paid', method: 'upi' },
    });
    await ctx.db.order.updateMany({ data: { customerName: 'Private Student Name' } });
    const admin = await adminAgent();

    const notes = await admin
      .put(`/api/v1/admin/shops/${shop.shopId}/notes`)
      .send({ notes: 'Owner prefers calls after 6pm.' });
    expect(notes.status).toBe(200);

    const detail = await admin.get(`/api/v1/admin/shops/${shop.shopId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.shop.adminNotes).toBe('Owner prefers calls after 6pm.');
    expect(detail.body.daily).toHaveLength(30);
    expect(detail.body.byMethod).toEqual([{ method: 'upi', count: 1, amountPaise: 500 }]);
    expect(detail.body.recent[0]).toMatchObject({
      status: 'completed',
      paymentMethod: 'upi',
      amountPaise: 500,
    });
    expect(JSON.stringify(detail.body)).not.toContain('Private Student Name');

    const owner = await signIn(shop);
    const list = await owner.get('/api/v1/owner/shops');
    const one = await owner.get(`/api/v1/owner/shops/${shop.shopId}`);
    expect(JSON.stringify([list.body, one.body])).not.toContain('calls after 6pm');
    const log = await ctx.db.auditLog.findMany({ where: { action: 'shop.notes_updated' } });
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain('calls after 6pm');
  });

  it('flags what needs attention and is for platform admins only', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await seedShop(ctx, 'Waiting Prints', 'waiting-prints', { status: 'pending_approval' });
    await seedOrder(alpha.shopId, { status: 'rejected', online: { state: 'refund_failed' } });
    const admin = await adminAgent();

    const overview = await admin.get('/api/v1/admin/overview');
    const kinds = overview.body.attention.map(
      (a: { kind: string; shopName: string }) => `${a.kind}:${a.shopName}`,
    );
    expect(kinds).toContain('waiting_approval:Waiting Prints');
    expect(kinds).toContain('refund_failed:Alpha Prints');

    const owner = await signIn(alpha);
    expect((await owner.get('/api/v1/admin/overview')).status).toBe(403);
    expect((await owner.get(`/api/v1/admin/shops/${alpha.shopId}`)).status).toBe(403);
    expect(
      (await owner.put(`/api/v1/admin/shops/${alpha.shopId}/notes`).send({ notes: 'x' })).status,
    ).toBe(403);
    expect((await request(ctx.app).get('/api/v1/admin/overview')).status).toBe(401);
  });
});
