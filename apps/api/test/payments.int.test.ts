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
    payment?: { method: 'cash' | 'upi' | 'card'; amountPaise: number };
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
      ...(opts.payment
        ? {
            paymentMethod: opts.payment.method,
            paidAmountPaise: opts.payment.amountPaise,
            paidAt: new Date(),
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

const act = (agent: ReturnType<typeof request.agent>, shopId: string, id: string, body: object) =>
  agent.post(`/api/v1/owner/shops/${shopId}/orders/${id}/actions`).send(body);

describe('recording a payment', () => {
  it('records how the student paid, defaulting to the amount due, and shows it in the queue', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(shop);
    const order = await seedOrder(shop.shopId, { status: 'completed', amountPaise: 750 });

    const res = await act(agent, shop.shopId, order.id, {
      action: 'record_payment',
      method: 'upi',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.payment).toMatchObject({ method: 'upi', amountPaise: 750 });

    const queue = await agent.get(`/api/v1/owner/shops/${shop.shopId}/orders`);
    expect(queue.body.orders[0].payment).toMatchObject({ method: 'upi', amountPaise: 750 });
  });

  it('takes the amount actually collected and lets the shop correct a mistake', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(shop);
    const order = await seedOrder(shop.shopId, { status: 'completed', amountPaise: 750 });

    await act(agent, shop.shopId, order.id, {
      action: 'record_payment',
      method: 'cash',
      amountPaise: 700,
    });
    const fixed = await act(agent, shop.shopId, order.id, {
      action: 'record_payment',
      method: 'card',
      amountPaise: 750,
    });
    expect(fixed.body.payment).toMatchObject({ method: 'card', amountPaise: 750 });

    const log = await ctx.db.auditLog.findMany({
      where: { shopId: shop.shopId, action: { startsWith: 'order.payment' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual(['order.payment_recorded', 'order.payment_corrected']);
  });

  it('refuses rejected orders, bad methods and other shops’ orders', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const agent = await signIn(alpha);
    const rejected = await seedOrder(alpha.shopId, { status: 'rejected' });
    const theirs = await seedOrder(beta.shopId, { status: 'completed' });
    const ok = await seedOrder(alpha.shopId, { status: 'completed' });

    const onRejected = await act(agent, alpha.shopId, rejected.id, {
      action: 'record_payment',
      method: 'cash',
    });
    expect(onRejected.status).toBe(409);
    expect(
      (await act(agent, alpha.shopId, ok.id, { action: 'record_payment', method: 'bitcoin' }))
        .status,
    ).toBe(400);
    expect(
      (
        await act(agent, alpha.shopId, ok.id, {
          action: 'record_payment',
          method: 'cash',
          amountPaise: -5,
        })
      ).status,
    ).toBe(400);
    expect(
      (await act(agent, alpha.shopId, theirs.id, { action: 'record_payment', method: 'cash' }))
        .status,
    ).toBe(404);
    expect((await ctx.db.order.findUnique({ where: { id: theirs.id } }))?.paymentMethod).toBeNull();
  });
});

describe("the shop's daily summary", () => {
  it('adds up today only: orders, pages, money by method, and what is still unpaid', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(shop);
    await seedOrder(shop.shopId, {
      amountPaise: 500,
      sides: 10,
      payment: { method: 'cash', amountPaise: 500 },
    });
    await seedOrder(shop.shopId, {
      amountPaise: 300,
      sides: 4,
      payment: { method: 'upi', amountPaise: 300 },
    });
    await seedOrder(shop.shopId, { amountPaise: 200, sides: 2 }); // printed, not yet paid
    await seedOrder(shop.shopId, { status: 'rejected', sides: 50 });
    await seedOrder(shop.shopId, {
      daysAgo: 1,
      amountPaise: 9999,
      sides: 99,
      payment: { method: 'cash', amountPaise: 9999 },
    });

    const res = await agent.get(`/api/v1/owner/shops/${shop.shopId}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      date: dateKey(),
      orders: 4,
      printed: 3,
      rejected: 1,
      pages: 16,
      collectedPaise: 800,
      unpaidCount: 1,
      unpaidPaise: 200,
    });
    expect(res.body.byMethod).toEqual([
      { method: 'cash', count: 1, amountPaise: 500 },
      { method: 'upi', count: 1, amountPaise: 300 },
    ]);
  });

  it('is private to the shop and needs sign-in', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    await seedOrder(beta.shopId, {
      amountPaise: 400,
      payment: { method: 'cash', amountPaise: 400 },
    });
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
      payment: { method: 'cash', amountPaise: 500 },
    });
    await seedOrder(alpha.shopId, {
      daysAgo: 3,
      amountPaise: 300,
      sides: 5,
      payment: { method: 'upi', amountPaise: 300 },
    });
    await seedOrder(alpha.shopId, {
      daysAgo: 40,
      amountPaise: 8000,
      sides: 80,
      payment: { method: 'cash', amountPaise: 8000 },
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
      unpaidCount: 0,
    });
    expect(b.stats30).toMatchObject({
      orders: 1,
      collectedPaise: 0,
      unpaidCount: 1,
      unpaidPaise: 200,
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
      { method: 'cash', count: 1, amountPaise: 500 },
      { method: 'upi', count: 1, amountPaise: 300 },
    ]);
  });

  it('gives one shop in depth without student names, and keeps private notes out of the owner’s reach', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await ctx.db.order.deleteMany({});
    await seedOrder(shop.shopId, {
      amountPaise: 500,
      sides: 10,
      payment: { method: 'cash', amountPaise: 500 },
    });
    await ctx.db.order.updateMany({ data: { customerName: 'Private Student Name' } });
    const admin = await adminAgent();

    const notes = await admin
      .put(`/api/v1/admin/shops/${shop.shopId}/notes`)
      .send({ notes: 'Owner prefers calls after 6pm.' });
    expect(notes.status).toBe(200);
    expect(notes.body.adminNotes).toBe('Owner prefers calls after 6pm.');

    const detail = await admin.get(`/api/v1/admin/shops/${shop.shopId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.shop.adminNotes).toBe('Owner prefers calls after 6pm.');
    expect(detail.body.daily).toHaveLength(30);
    expect(detail.body.byMethod).toEqual([{ method: 'cash', count: 1, amountPaise: 500 }]);
    expect(detail.body.recent[0]).toMatchObject({
      status: 'completed',
      paymentMethod: 'cash',
      amountPaise: 500,
    });
    expect(JSON.stringify(detail.body)).not.toContain('Private Student Name');

    // The notes never reach the shop owner's own view of the shop, and the note text is not logged.
    const owner = await signIn(shop);
    const list = await owner.get('/api/v1/owner/shops');
    const one = await owner.get(`/api/v1/owner/shops/${shop.shopId}`);
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);
    expect(JSON.stringify([list.body, one.body])).not.toContain('calls after 6pm');
    const log = await ctx.db.auditLog.findMany({ where: { action: 'shop.notes_updated' } });
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain('calls after 6pm');
  });

  it('flags what needs attention and is for platform admins only', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await seedShop(ctx, 'Waiting Prints', 'waiting-prints', { status: 'pending_approval' });
    for (let i = 0; i < 5; i++) await seedOrder(alpha.shopId, { amountPaise: 100 }); // printed, never paid
    const admin = await adminAgent();

    const overview = await admin.get('/api/v1/admin/overview');
    const kinds = overview.body.attention.map(
      (a: { kind: string; shopName: string }) => `${a.kind}:${a.shopName}`,
    );
    expect(kinds).toContain('waiting_approval:Waiting Prints');
    expect(kinds).toContain('unpaid:Alpha Prints');

    const owner = await signIn(alpha);
    expect((await owner.get('/api/v1/admin/overview')).status).toBe(403);
    expect((await owner.get(`/api/v1/admin/shops/${alpha.shopId}`)).status).toBe(403);
    expect(
      (await owner.put(`/api/v1/admin/shops/${alpha.shopId}/notes`).send({ notes: 'x' })).status,
    ).toBe(403);
    expect((await request(ctx.app).get('/api/v1/admin/overview')).status).toBe(401);
  });
});
