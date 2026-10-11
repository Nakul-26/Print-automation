import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gsAvailable, makePdf, makePng, pdfInfo, renderMeans } from './fixtures.js';
import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  seedShop,
  type TestContext,
} from './helpers.js';

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

const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (t) => {
    if (!gsOk) t.skip();
    await fn();
  });

const defaults = {
  pageSelection: 'all',
  copies: 1,
  colorMode: 'black_white',
  sides: 'single',
  paperSize: 'A4',
  pagesPerSheet: 1,
} as const;

async function settle(context: TestContext, token: string) {
  for (let i = 0; i < 100; i++) {
    const res = await request(context.app).get(`/api/v1/uploads/${token}`);
    if (res.body.status !== 'processing') return res;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('upload did not finish processing');
}

/** Uploads a PDF with `pages` pages and waits until it is ready. Returns its token. */
async function uploadPdf(context: TestContext, pages: number, slug = SLUG, name = 'doc.pdf') {
  const res = await request(context.app)
    .post(`/api/v1/shops/${slug}/uploads`)
    .attach('file', await makePdf(pages), { filename: name, contentType: 'application/pdf' });
  expect(res.status).toBe(201);
  const done = await settle(context, res.body.token);
  expect(done.body.status).toBe('ready');
  return res.body.token as string;
}

async function waitForOrder(context: TestContext, lookupToken: string, status = 'pending') {
  for (let i = 0; i < 100; i++) {
    const res = await request(context.app).get(`/api/v1/orders/${lookupToken}`);
    if (res.body.status === status || res.body.status === 'failed') return res;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('order did not reach the expected status');
}

/** Like place(), but fails with the server's answer unless the order was created. */
async function placeOk(context: TestContext, body: unknown, slug = SLUG) {
  const res = await place(context, body, slug);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res;
}

const place = (
  context: TestContext,
  body: unknown,
  slug = SLUG,
  headers: Record<string, string> = {},
) =>
  request(context.app)
    .post(`/api/v1/shops/${slug}/orders`)
    .set(headers)
    .send(body as object);

describe('storefront', () => {
  it('shows a shop its public details, prices, and limits', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await request(ctx.app).get(`/api/v1/shops/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: SLUG,
      name: 'Alpha Prints',
      currency: 'INR',
      minimumChargePaise: 200,
      turnstileSiteKey: null,
    });
    expect(res.body.rates).toHaveLength(3);
    expect(res.body.limits.maxCopies).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/ownerEmail|passwordHash|shopId/);
  });

  it('hides unknown, pending, and suspended shops', async () => {
    await seedShop(ctx, 'Pending', 'pending-shop', { status: 'pending_approval' });
    await seedShop(ctx, 'Gone', 'gone-shop', { status: 'suspended' });
    for (const slug of ['nope-shop', 'pending-shop', 'gone-shop']) {
      expect((await request(ctx.app).get(`/api/v1/shops/${slug}`)).status).toBe(404);
    }
  });
});

describe('estimate', () => {
  it('prices a document by printed sides', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 5);
    const res = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: token, settings: { ...defaults, copies: 2 } }] });

    expect(res.status).toBe(200);
    // 5 pages x 2 copies x Rs 2 = Rs 20
    expect(res.body).toMatchObject({
      subtotalPaise: 2000,
      totalPaise: 2000,
      minimumApplied: false,
      isEstimate: true,
    });
    expect(res.body.items[0]).toMatchObject({ selectedPageCount: 5, printedSides: 10, sheets: 10 });
  });

  it('follows page ranges, double-sided, and pages per sheet', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 12);
    const estimate = async (settings: object) =>
      (
        await request(ctx.app)
          .post(`/api/v1/shops/${SLUG}/estimate`)
          .send({ items: [{ uploadToken: token, settings: { ...defaults, ...settings } }] })
      ).body;

    const range = await estimate({ pageSelection: 'custom', pages: '1-3, 7, 10-11' });
    expect(range.items[0]).toMatchObject({ selectedPageCount: 6, amountPaise: 1200 });

    const double = await estimate({ sides: 'double' });
    expect(double.items[0]).toMatchObject({ printedSides: 12, sheets: 6, amountPaise: 1800 });

    const twoUp = await estimate({ pagesPerSheet: 2 });
    expect(twoUp.items[0]).toMatchObject({ printedSides: 6, amountPaise: 1200 });

    const colour = await estimate({ colorMode: 'color', pageSelection: 'custom', pages: '1' });
    expect(colour.items[0].amountPaise).toBe(1000);
  });

  it('applies the shop minimum charge', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 1);
    const res = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: token, settings: defaults }] });
    expect(res.body).toMatchObject({ subtotalPaise: 200, totalPaise: 200 });

    // A shop with a higher minimum
    await ctx.container.pricing.setRates((await ctx.db.shop.findFirstOrThrow()).id, {
      minimumChargePaise: 500,
      rates: [
        { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 200 },
      ],
    });
    const again = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: token, settings: defaults }] });
    expect(again.body).toMatchObject({ subtotalPaise: 200, totalPaise: 500, minimumApplied: true });
  });

  it('refuses combinations the shop does not price', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 2);
    const res = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: token, settings: { ...defaults, paperSize: 'A3' } }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('rate_unavailable');
    expect(res.body.error.message).toMatch(/A3/);
  });

  it('rejects bad page ranges, too many copies, duplicates, and malformed requests', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 3);
    const post = (items: unknown) =>
      request(ctx.app).post(`/api/v1/shops/${SLUG}/estimate`).send({ items });

    expect(
      (
        await post([
          { uploadToken: token, settings: { ...defaults, pageSelection: 'custom', pages: '2-9' } },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await post([
          { uploadToken: token, settings: { ...defaults, pageSelection: 'custom', pages: '' } },
        ])
      ).status,
    ).toBe(400);
    expect(
      (await post([{ uploadToken: token, settings: { ...defaults, copies: 99999 } }])).status,
    ).toBe(400);
    expect(
      (await post([{ uploadToken: token, settings: { ...defaults, copies: 0 } }])).status,
    ).toBe(400);
    expect(
      (
        await post([
          { uploadToken: token, settings: defaults },
          { uploadToken: token, settings: defaults },
        ])
      ).status,
    ).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post([{ uploadToken: 'short', settings: defaults }])).status).toBe(400);
  });

  it('does not accept an upload that is not ready, expired, or from another shop', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    await seedShop(ctx, 'Beta Copies', 'beta-copies');
    const betaToken = await uploadPdf(ctx, 2, 'beta-copies');

    const crossShop = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: betaToken, settings: defaults }] });
    expect(crossShop.status).toBe(404);

    const pending = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/uploads`)
      .attach('file', await makePng(), { filename: 'a.png', contentType: 'image/png' });
    await ctx.db.upload.updateMany({
      where: { id: pending.body.upload.id },
      data: { status: 'processing' },
    });
    const notReady = await request(ctx.app)
      .post(`/api/v1/shops/${SLUG}/estimate`)
      .send({ items: [{ uploadToken: pending.body.token, settings: defaults }] });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('upload_not_ready');
  });
});

describe('placing an order', () => {
  gsIt('creates an order with a queue number, then prepares the print PDF', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 6, SLUG, 'assignment.pdf');

    const res = await place(ctx, {
      customerName: '  Rahul  ',
      items: [
        {
          uploadToken: token,
          settings: {
            ...defaults,
            pageSelection: 'custom',
            pages: '1-4',
            copies: 3,
            sides: 'double',
          },
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.lookupToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.body.order).toMatchObject({
      queueNumber: 'P001',
      status: 'processing',
      customerName: 'Rahul',
      shopName: 'Alpha Prints',
      // 4 pages x 3 copies x Rs 1.50 (double-sided rate)
      totalPaise: 1800,
      aheadCount: 0,
    });
    expect(res.body.order.items[0]).toMatchObject({
      originalName: 'assignment.pdf',
      pageCount: 6,
      selectedPageCount: 4,
      printedSides: 12,
      sheets: 6,
      amountPaise: 1800,
    });

    const ready = await waitForOrder(ctx, res.body.lookupToken);
    expect(ready.body.status).toBe('pending');

    // The prepared PDF holds exactly the selected pages.
    const item = await ctx.db.orderItem.findFirstOrThrow();
    expect(item.printPdfPages).toBe(4);
    const pdf = await ctx.container.storage.get(item.printPdfKey!);
    expect((await pdfInfo(pdf)).count).toBe(4);
    expect(item.printPdfKey).toMatch(/^print\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);
  });

  gsIt('bakes black-and-white into a truly grayscale PDF', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 1);
    const res = await place(ctx, { items: [{ uploadToken: token, settings: defaults }] });
    await waitForOrder(ctx, res.body.lookupToken);

    const item = await ctx.db.orderItem.findFirstOrThrow();
    const [r, g, b] = await renderMeans(await ctx.container.storage.get(item.printPdfKey!));
    expect(r).toBeCloseTo(g, 0);
    expect(g).toBeCloseTo(b, 0);
  });

  gsIt('keeps colour for colour orders', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 1);
    const res = await place(ctx, {
      items: [{ uploadToken: token, settings: { ...defaults, colorMode: 'color' } }],
    });
    await waitForOrder(ctx, res.body.lookupToken);
    const item = await ctx.db.orderItem.findFirstOrThrow();
    const [r, , b] = await renderMeans(await ctx.container.storage.get(item.printPdfKey!));
    expect(Math.abs(r - b)).toBeGreaterThan(5);
  });

  gsIt('lays pages out N-up in the print PDF', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 8);
    const res = await place(ctx, {
      items: [{ uploadToken: token, settings: { ...defaults, pagesPerSheet: 4 } }],
    });
    expect(res.body.order.items[0].printedSides).toBe(2);
    await waitForOrder(ctx, res.body.lookupToken);
    const item = await ctx.db.orderItem.findFirstOrThrow();
    expect(item.printPdfPages).toBe(2);
  });

  it('accepts several documents with their own settings', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const a = await uploadPdf(ctx, 3, SLUG, 'a.pdf');
    const b = await uploadPdf(ctx, 2, SLUG, 'b.pdf');
    const res = await place(ctx, {
      items: [
        { uploadToken: a, settings: defaults },
        { uploadToken: b, settings: { ...defaults, colorMode: 'color' } },
      ],
    });
    expect(res.status).toBe(201);
    // 3 x Rs 2 + 2 x Rs 10 = Rs 26
    expect(res.body.order.totalPaise).toBe(2600);
    expect(res.body.order.items.map((i: { originalName: string }) => i.originalName)).toEqual([
      'a.pdf',
      'b.pdf',
    ]);
  });

  it('does not let one upload be ordered twice', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 2);
    const first = await place(ctx, { items: [{ uploadToken: token, settings: defaults }] });
    expect(first.status).toBe(201);
    const second = await place(ctx, { items: [{ uploadToken: token, settings: defaults }] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('upload_already_ordered');
    expect(await ctx.db.order.count()).toBe(1);
  });

  it('keeps ordered files for 24 hours from the order, not the upload', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 2);
    await ctx.db.upload.updateMany({ data: { expiresAt: new Date(Date.now() + 60_000) } });
    const res = await place(ctx, { items: [{ uploadToken: token, settings: defaults }] });
    const hours =
      (new Date(res.body.order.expiresAt).getTime() -
        new Date(res.body.order.createdAt).getTime()) /
      3_600_000;
    expect(hours).toBeCloseTo(24, 1);
    const upload = await ctx.db.upload.findFirstOrThrow();
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('snapshots the rates and ignores later price changes', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', SLUG);
    const token = await uploadPdf(ctx, 5);
    const res = await place(ctx, { items: [{ uploadToken: token, settings: defaults }] });
    expect(res.body.order.totalPaise).toBe(1000);

    await ctx.container.pricing.setRates(shop.shopId, {
      minimumChargePaise: 0,
      rates: [
        { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 900 },
      ],
    });
    const again = await request(ctx.app).get(`/api/v1/orders/${res.body.lookupToken}`);
    expect(again.body.totalPaise).toBe(1000);
    const row = await ctx.db.order.findFirstOrThrow();
    expect((row.rateSnapshot as { rates: unknown[] }).rates).toHaveLength(3);
  });
});

describe('queue numbers', () => {
  it('gives every order of the day a unique, increasing number, even when placed at once', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => uploadPdf(ctx, 1)));

    const results = await Promise.all(
      tokens.map((t) => place(ctx, { items: [{ uploadToken: t, settings: defaults }] })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.order.queueNumber as string).sort();
    expect(numbers).toEqual(['P001', 'P002', 'P003', 'P004', 'P005', 'P006', 'P007', 'P008']);
  });

  it('numbers each shop separately and restarts each day', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', SLUG);
    await seedShop(ctx, 'Beta Copies', 'beta-copies');

    const a1 = await place(ctx, {
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    const b1 = await place(
      ctx,
      { items: [{ uploadToken: await uploadPdf(ctx, 1, 'beta-copies'), settings: defaults }] },
      'beta-copies',
    );
    expect(a1.body.order.queueNumber).toBe('P001');
    expect(b1.body.order.queueNumber).toBe('P001');

    // Pretend today's counter belongs to yesterday: the next order starts a new day at P001.
    await ctx.db.orderCounter.updateMany({
      where: { shopId: alpha.shopId },
      data: { dateKey: '2020-01-01' },
    });
    await ctx.db.order.updateMany({
      where: { shopId: alpha.shopId },
      data: { queueDate: '2020-01-01' },
    });
    const a2 = await place(ctx, {
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    expect(a2.body.order.queueNumber).toBe('P001');
  });

  it('tells the student how many orders are ahead', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const one = await placeOk(ctx, {
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    const two = await placeOk(ctx, {
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    expect(one.body.order.aheadCount).toBe(0);
    expect(two.body.order.aheadCount).toBe(1);

    await ctx.db.order.updateMany({ where: { queueNumber: 1 }, data: { status: 'completed' } });
    const again = await request(ctx.app).get(`/api/v1/orders/${two.body.lookupToken}`);
    expect(again.body.aheadCount).toBe(0);
  });
});

describe('order status lookup', () => {
  it('only works with the secret token', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await placeOk(ctx, {
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    const t: string = res.body.lookupToken;

    expect((await request(ctx.app).get(`/api/v1/orders/${t}`)).status).toBe(200);
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    expect((await request(ctx.app).get(`/api/v1/orders/${tampered}`)).status).toBe(404);
    expect((await request(ctx.app).get('/api/v1/orders/not-a-token')).status).toBe(404);
    expect((await request(ctx.app).get('/api/v1/orders/P001')).status).toBe(404);

    const row = await ctx.db.order.findFirstOrThrow();
    expect(row.lookupTokenHash).not.toContain(t);
  });

  it('never reveals other students or file locations', async () => {
    await seedShop(ctx, 'Alpha Prints', SLUG);
    const res = await placeOk(ctx, {
      customerName: 'Rahul',
      items: [{ uploadToken: await uploadPdf(ctx, 1), settings: defaults }],
    });
    const json = JSON.stringify(
      (await request(ctx.app).get(`/api/v1/orders/${res.body.lookupToken}`)).body,
    );
    expect(json).not.toMatch(/originals\/|normalized\/|print\/|shopId|uploadId|sourceKey/);
  });
});

describe('bot protection', () => {
  const secrets = { TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_SITE_KEY: 'test-site' };

  it('exposes the site key and refuses orders without a valid token when enabled', async () => {
    const guarded = createTestContext({ ...secrets, STORAGE_ROOT: ctx.storageRoot });
    try {
      await guarded.container.start();
      await seedShop(guarded, 'Alpha Prints', SLUG);
      const info = await request(guarded.app).get(`/api/v1/shops/${SLUG}`);
      expect(info.body.turnstileSiteKey).toBe('test-site');

      const token = await uploadPdf(guarded, 1);
      const res = await place(guarded, { items: [{ uploadToken: token, settings: defaults }] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('bot_check_failed');
      expect(await guarded.db.order.count()).toBe(0);
    } finally {
      await guarded.close();
    }
  });
});

describe('rate limits', () => {
  it('limits how many orders one connection can place', async () => {
    const limited = createTestContext({ ORDER_RATE_LIMIT_MAX: '2', STORAGE_ROOT: ctx.storageRoot });
    try {
      await limited.container.start();
      await seedShop(limited, 'Alpha Prints', SLUG);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const token = await uploadPdf(limited, 1);
        statuses.push(
          (await place(limited, { items: [{ uploadToken: token, settings: defaults }] })).status,
        );
      }
      expect(statuses).toEqual([201, 201, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('owner rate card', () => {
  async function signIn(email: string) {
    const agent = request.agent(ctx.app);
    expect(
      (await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD })).status,
    ).toBe(200);
    return agent;
  }

  it('lets an owner read and replace their prices', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', SLUG);
    const agent = await signIn(shop.ownerEmail);

    const current = await agent.get(`/api/v1/owner/shops/${shop.shopId}/rates`);
    expect(current.status).toBe(200);
    expect(current.body.minimumChargePaise).toBe(200);

    const next = {
      minimumChargePaise: 300,
      rates: [
        { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 250 },
        { paperSize: 'A4', colorMode: 'color', sides: 'single', pricePerSidePaise: 1200 },
      ],
    };
    expect((await agent.put(`/api/v1/owner/shops/${shop.shopId}/rates`).send(next)).status).toBe(
      200,
    );

    const pub = await request(ctx.app).get(`/api/v1/shops/${SLUG}`);
    expect(pub.body.rates).toHaveLength(2);
    expect(pub.body.minimumChargePaise).toBe(300);
  });

  it('rejects invalid price cards', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', SLUG);
    const agent = await signIn(shop.ownerEmail);
    const put = (body: unknown) =>
      agent.put(`/api/v1/owner/shops/${shop.shopId}/rates`).send(body as object);
    const rate = { paperSize: 'A4', colorMode: 'color', sides: 'single', pricePerSidePaise: 100 };

    expect((await put({ minimumChargePaise: 0, rates: [rate, rate] })).status).toBe(400); // duplicate
    expect(
      (await put({ minimumChargePaise: 0, rates: [{ ...rate, pricePerSidePaise: -1 }] })).status,
    ).toBe(400);
    expect(
      (await put({ minimumChargePaise: 0, rates: [{ ...rate, pricePerSidePaise: 1.5 }] })).status,
    ).toBe(400);
    expect(
      (await put({ minimumChargePaise: 0, rates: [{ ...rate, paperSize: 'Letter' }] })).status,
    ).toBe(400);
  });

  it("keeps one shop's prices away from another shop's owner", async () => {
    const a = await seedShop(ctx, 'Alpha Prints', SLUG);
    const b = await seedShop(ctx, 'Beta Copies', 'beta-copies');
    const agentA = await signIn(a.ownerEmail);

    expect((await agentA.get(`/api/v1/owner/shops/${b.shopId}/rates`)).status).toBe(404);
    const put = await agentA
      .put(`/api/v1/owner/shops/${b.shopId}/rates`)
      .send({ minimumChargePaise: 0, rates: [] });
    expect(put.status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/owner/shops/${a.shopId}/rates`)).status).toBe(401);
    expect((await ctx.container.pricing.getRateTable(b.shopId)).rates).toHaveLength(3);
  });

  it('only lets owners, not staff, change prices', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', SLUG);
    const staff = await ctx.container.identity.users.create({
      email: 'staff@example.com',
      name: 'Staff',
      password: PASSWORD,
    });
    await ctx.container.shops.addMember({ shopId: shop.shopId, userId: staff.id, role: 'staff' });
    const agent = await signIn('staff@example.com');

    expect((await agent.get(`/api/v1/owner/shops/${shop.shopId}/rates`)).status).toBe(200);
    const put = await agent
      .put(`/api/v1/owner/shops/${shop.shopId}/rates`)
      .send({ minimumChargePaise: 0, rates: [] });
    expect(put.status).toBe(403);
  });
});
