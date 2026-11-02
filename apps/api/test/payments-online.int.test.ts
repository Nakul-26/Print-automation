import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFakeGateway, GOOD_KEYS, type FakeGateway } from './fake-gateway.js';
import { gsAvailable, makePdf } from './fixtures.js';
import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  seedShop,
  type SeededShop,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let fake: FakeGateway;
let gsOk = false;

beforeAll(async () => {
  gsOk = await gsAvailable();
  fake = createFakeGateway();
  ctx = createTestContext({}, fake.gateway);
  await ctx.container.start();
});
afterAll(() => ctx.close());
beforeEach(async () => {
  await resetDatabase(ctx.db);
  fake.orders.clear();
  fake.refunds.length = 0;
  fake.state.down = false;
  fake.state.refundError = null;
  fake.state.captureMode = 'captured';
});

const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (t) => {
    if (!gsOk) t.skip();
    await fn();
  });

const settings = {
  pageSelection: 'all',
  copies: 1,
  colorMode: 'black_white',
  sides: 'single',
  paperSize: 'A4',
  pagesPerSheet: 1,
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function signIn(email: string) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

/** A shop with online payment switched on, and its signed-in owner. */
async function shopWithPayments(name = 'Alpha Prints', slug = 'alpha-prints') {
  const shop = await seedShop(ctx, name, slug);
  const owner = await signIn(shop.ownerEmail);
  const saved = await owner
    .put(`/api/v1/owner/shops/${shop.shopId}/payments/keys`)
    .send({ ...GOOD_KEYS, enabled: true });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return { shop, owner };
}

/** Uploads a three-page PDF and places an order for it; returns the response of the order call. */
async function placeOrder(slug: string, payment: 'online' | 'counter') {
  const up = await request(ctx.app)
    .post(`/api/v1/shops/${slug}/uploads`)
    .attach('file', await makePdf(3), { filename: 'notes.pdf', contentType: 'application/pdf' });
  expect(up.status).toBe(201);
  await until(
    async () =>
      (await request(ctx.app).get(`/api/v1/uploads/${up.body.token}`)).body.status === 'ready',
    'upload',
  );
  return request(ctx.app)
    .post(`/api/v1/shops/${slug}/orders`)
    .send({ customerName: 'Asha', payment, items: [{ uploadToken: up.body.token, settings }] });
}

const queue = (owner: ReturnType<typeof request.agent>, shopId: string) =>
  owner.get(`/api/v1/owner/shops/${shopId}/orders`);
const payUrl = (token: string, rest = '') => `/api/v1/orders/${token}/payment${rest}`;
const confirm = (token: string, body: object) =>
  request(ctx.app).post(payUrl(token, '/confirm')).send(body);

describe('the shop’s payment settings', () => {
  it('saves working keys encrypted, never shows the secret, and refuses wrong keys', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop.ownerEmail);
    const url = `/api/v1/owner/shops/${shop.shopId}/payments`;

    expect((await owner.get(url)).body).toMatchObject({
      configured: false,
      enabled: false,
      keyId: null,
    });

    const bad = await owner
      .put(`${url}/keys`)
      .send({ keyId: GOOD_KEYS.keyId, keySecret: 'a-wrong-secret-value' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_payment_keys');

    const saved = await owner.put(`${url}/keys`).send(GOOD_KEYS);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      enabled: false,
      keyId: GOOD_KEYS.keyId,
      mode: 'test',
    });
    expect(JSON.stringify(saved.body)).not.toContain(GOOD_KEYS.keySecret);
    expect(JSON.stringify((await owner.get(url)).body)).not.toContain(GOOD_KEYS.keySecret);

    // Only an encrypted value is stored.
    const row = await ctx.db.shopPaymentSettings.findUniqueOrThrow({
      where: { shopId: shop.shopId },
    });
    expect(row.keySecretEnc).not.toContain(GOOD_KEYS.keySecret);
    expect(row.keySecretEnc.startsWith('v1.')).toBe(true);

    // Students are only offered online payment once the shop switches it on.
    expect((await request(ctx.app).get('/api/v1/shops/alpha-prints')).body.onlinePayments).toBe(
      false,
    );
    expect((await owner.post(`${url}/enabled`).send({ enabled: true })).body.enabled).toBe(true);
    expect((await request(ctx.app).get('/api/v1/shops/alpha-prints')).body.onlinePayments).toBe(
      true,
    );
    expect((await owner.post(`${url}/enabled`).send({ enabled: false })).body.enabled).toBe(false);
    expect((await request(ctx.app).get('/api/v1/shops/alpha-prints')).body.onlinePayments).toBe(
      false,
    );

    const log = await ctx.db.auditLog.findMany({
      where: { shopId: shop.shopId, action: { startsWith: 'payments.' } },
    });
    expect(JSON.stringify(log)).not.toContain(GOOD_KEYS.keySecret);
  });

  it('cannot be switched on without keys, and can be removed again', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop.ownerEmail);
    const url = `/api/v1/owner/shops/${shop.shopId}/payments`;
    expect((await owner.post(`${url}/enabled`).send({ enabled: true })).status).toBe(409);

    await owner.put(`${url}/keys`).send({ ...GOOD_KEYS, enabled: true });
    expect((await owner.delete(`${url}/keys`)).body).toMatchObject({
      configured: false,
      enabled: false,
    });
    expect((await request(ctx.app).get('/api/v1/shops/alpha-prints')).body.onlinePayments).toBe(
      false,
    );
  });

  it('is for the owner only, and never for another shop’s owner', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const alphaOwner = await signIn(alpha.ownerEmail);
    const betaOwner = await signIn(beta.ownerEmail);

    // Alpha's owner adds a staff member, who must not see or change payment keys.
    const staff = await alphaOwner
      .post(`/api/v1/owner/shops/${alpha.shopId}/staff`)
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    const staffAgent = request.agent(ctx.app);
    await staffAgent
      .post('/api/v1/auth/login')
      .send({ email: 'ravi@example.com', password: staff.body.password });
    const url = `/api/v1/owner/shops/${alpha.shopId}/payments`;
    expect((await staffAgent.get(url)).status).toBe(403);
    expect((await staffAgent.put(`${url}/keys`).send(GOOD_KEYS)).status).toBe(403);

    expect((await betaOwner.get(url)).status).toBe(404);
    expect((await betaOwner.put(`${url}/keys`).send(GOOD_KEYS)).status).toBe(404);
    expect((await request(ctx.app).get(url)).status).toBe(401);
  });
});

describe('paying online', () => {
  gsIt('hides the order from the shop until the money arrives, then shows it as paid', async () => {
    const { shop, owner } = await shopWithPayments();
    const placed = await placeOrder('alpha-prints', 'online');
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);

    // The browser gets what it needs to open the payment window, and never the secret.
    expect(placed.body.checkout).toMatchObject({
      keyId: GOOD_KEYS.keyId,
      amountPaise: 600,
      currency: 'INR',
      shopName: 'Alpha Prints',
      testMode: true,
    });
    expect(JSON.stringify(placed.body)).not.toContain(GOOD_KEYS.keySecret);
    expect(placed.body.order.payment).toMatchObject({ state: 'awaiting' });

    const token = placed.body.lookupToken as string;
    await until(
      async () => (await request(ctx.app).get(`/api/v1/orders/${token}`)).body.status === 'pending',
      'order to become pending',
    );

    // Not in the shop's queue yet, and not counted ahead of anyone.
    expect((await queue(owner, shop.shopId)).body.orders).toHaveLength(0);

    // The student pays; the window hands back a signed result.
    const paid = fake.pay(placed.body.checkout.gatewayOrderId, 'upi');
    const confirmed = await confirm(token, paid);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.payment).toMatchObject({
      state: 'paid',
      amountPaise: 600,
      method: 'upi',
    });
    expect(confirmed.body.checkout).toBeNull();

    // Now the shop sees it, already paid.
    const orders = (await queue(owner, shop.shopId)).body.orders;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      status: 'pending',
      payment: { state: 'paid', method: 'upi', amountPaise: 600 },
    });
    const summary = (await owner.get(`/api/v1/owner/shops/${shop.shopId}/summary`)).body;
    expect(summary).toMatchObject({
      collectedPaise: 600,
      byMethod: [{ method: 'upi', count: 1, amountPaise: 600 }],
    });

    // Confirming again is harmless.
    expect((await confirm(token, paid)).body.payment.state).toBe('paid');
  });

  gsIt('never believes a forged or mismatched confirmation', async () => {
    const { shop, owner } = await shopWithPayments();
    const placed = await placeOrder('alpha-prints', 'online');
    const token = placed.body.lookupToken as string;
    const gatewayOrderId = placed.body.checkout.gatewayOrderId as string;

    const forged = await confirm(token, fake.forged(gatewayOrderId));
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('payment_signature_invalid');

    // A real payment of ANOTHER order cannot be used to pay this one.
    const other = await placeOrder('alpha-prints', 'online');
    const otherPaid = fake.pay(other.body.checkout.gatewayOrderId);
    expect((await confirm(token, otherPaid)).status).toBe(400);

    // A missing or garbage token is a plain 404.
    expect((await confirm('x'.repeat(32), otherPaid)).status).toBe(404);
    expect((await request(ctx.app).get(payUrl('nope'))).status).toBe(404);

    expect((await request(ctx.app).get(payUrl(token))).body.payment.state).toBe('awaiting');
    expect((await queue(owner, shop.shopId)).body.orders).toHaveLength(0);
    const log = await ctx.db.auditLog.findMany({ where: { action: 'payment.bad_signature' } });
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  gsIt('finds a payment the browser never confirmed (the student closed the window)', async () => {
    const { shop, owner } = await shopWithPayments();
    const placed = await placeOrder('alpha-prints', 'online');
    const token = placed.body.lookupToken as string;
    fake.pay(placed.body.checkout.gatewayOrderId, 'card'); // paid, but the page never told us

    expect((await queue(owner, shop.shopId)).body.orders).toHaveLength(0);
    const refreshed = await request(ctx.app).post(payUrl(token, '/refresh'));
    expect(refreshed.body.payment).toMatchObject({ state: 'paid', method: 'card' });
    expect((await queue(owner, shop.shopId)).body.orders).toHaveLength(1);
  });

  gsIt(
    'the background check settles unconfirmed payments too, and captures authorised ones',
    async () => {
      fake.state.captureMode = 'authorized';
      const { shop, owner } = await shopWithPayments();
      const placed = await placeOrder('alpha-prints', 'online');
      fake.pay(placed.body.checkout.gatewayOrderId);

      await ctx.container.payments.sweep();
      expect((await queue(owner, shop.shopId)).body.orders[0].payment).toMatchObject({
        state: 'paid',
      });
      const payment = [...fake.orders.values()][0]!.payments[0]!;
      expect(payment.status).toBe('captured');
    },
  );

  gsIt(
    'lets the student pay at the counter instead, but never after the money has gone through',
    async () => {
      const { shop, owner } = await shopWithPayments();
      const first = await placeOrder('alpha-prints', 'online');
      const switched = await request(ctx.app).post(payUrl(first.body.lookupToken, '/counter'));
      expect(switched.body.payment.state).toBe('none');
      const visible = (await queue(owner, shop.shopId)).body.orders;
      expect(visible).toHaveLength(1);
      expect(visible[0].payment).toBeNull();

      // Paid in the window but not yet seen by us, then the student taps "pay at the counter".
      const second = await placeOrder('alpha-prints', 'online');
      fake.pay(second.body.checkout.gatewayOrderId);
      const late = await request(ctx.app).post(payUrl(second.body.lookupToken, '/counter'));
      expect(late.body.payment.state).toBe('paid');
    },
  );

  gsIt('closes an order whose payment never arrives', async () => {
    const { shop, owner } = await shopWithPayments();
    const placed = await placeOrder('alpha-prints', 'online');
    const token = placed.body.lookupToken as string;

    await ctx.container.payments.sweep();
    expect((await request(ctx.app).get(`/api/v1/orders/${token}`)).body.status).not.toBe('expired');

    await ctx.db.$executeRawUnsafe(
      `UPDATE online_payments SET created_at = now() - interval '25 minutes'`,
    );
    await ctx.container.payments.sweep();
    const student = await request(ctx.app).get(`/api/v1/orders/${token}`);
    expect(student.body.status).toBe('expired');
    expect((await queue(owner, shop.shopId)).body.orders).toHaveLength(0);
    // A student who pays after the order was closed is not charged for nothing: the money goes back.
    const late = fake.pay(placed.body.checkout.gatewayOrderId);
    const tooLate = await confirm(token, late);
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.code).toBe('payment_expired');
    await until(async () => fake.refunds.length === 1, 'the late payment to be refunded');
    expect(fake.refunds[0]).toMatchObject({ amountPaise: 600 });

    // Same for someone who paid and closed the page without telling us.
    const second = await placeOrder('alpha-prints', 'online');
    await ctx.db.$executeRawUnsafe(
      `UPDATE online_payments SET created_at = now() - interval '25 minutes' WHERE status = 'awaiting'`,
    );
    await ctx.container.payments.sweep();
    fake.pay(second.body.checkout.gatewayOrderId);
    await ctx.container.payments.sweep();
    await until(async () => fake.refunds.length === 2, 'the second late payment to be refunded');
  });

  gsIt(
    'refuses online payment when the shop has none, and leaves nothing behind when the provider is down',
    async () => {
      const shop = await seedShop(ctx, 'Plain Prints', 'plain-prints');
      const none = await placeOrder('plain-prints', 'online');
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('online_payment_unavailable');
      expect(await ctx.db.order.count({ where: { shopId: shop.shopId } })).toBe(0);

      const { shop: other } = await shopWithPayments('Alpha Prints', 'alpha-prints');
      fake.state.down = true;
      const down = await placeOrder('alpha-prints', 'online');
      expect(down.status).toBe(502);
      expect(down.body.error.code).toBe('payment_provider_unavailable');
      expect(await ctx.db.order.count({ where: { shopId: other.shopId } })).toBe(0);

      // Paying at the counter still works while the provider is down.
      expect((await placeOrder('alpha-prints', 'counter')).status).toBe(201);
    },
  );

  gsIt('settles a paid order for exactly what was paid', async () => {
    const { shop, owner } = await shopWithPayments();
    const placed = await placeOrder('alpha-prints', 'online');
    const token = placed.body.lookupToken as string;
    await until(
      async () => (await request(ctx.app).get(`/api/v1/orders/${token}`)).body.status === 'pending',
      'pending',
    );
    await confirm(token, fake.pay(placed.body.checkout.gatewayOrderId));
    const [order] = (await queue(owner, shop.shopId)).body.orders;

    await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'print' });
    const done = await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'complete', finalAmountPaise: 1 });
    expect(done.body).toMatchObject({ status: 'completed', finalAmountPaise: 600 });
  });
});

describe('refunds', () => {
  async function paidOrder(shop: SeededShop) {
    const placed = await placeOrder(shop.slug, 'online');
    const token = placed.body.lookupToken as string;
    await until(
      async () => (await request(ctx.app).get(`/api/v1/orders/${token}`)).body.status === 'pending',
      'pending',
    );
    await confirm(token, fake.pay(placed.body.checkout.gatewayOrderId));
    return token;
  }

  gsIt('gives the money back when the shop rejects a paid order, exactly once', async () => {
    const { shop, owner } = await shopWithPayments();
    const token = await paidOrder(shop);
    const [order] = (await queue(owner, shop.shopId)).body.orders;

    const rejected = await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'reject', reason: 'Out of paper' });
    expect(rejected.status).toBe(200);

    await until(
      async () => (await request(ctx.app).get(payUrl(token))).body.payment.state === 'refunded',
      'refund',
    );
    expect(fake.refunds).toHaveLength(1);
    expect(fake.refunds[0]).toMatchObject({ amountPaise: 600 });
    expect((await queue(owner, shop.shopId)).body.orders[0].payment).toMatchObject({
      state: 'refunded',
    });

    // Running the background work again never refunds twice.
    await ctx.container.payments.sweep();
    expect(fake.refunds).toHaveLength(1);
    // And a refunded order no longer counts as money collected.
    const summary = (await owner.get(`/api/v1/owner/shops/${shop.shopId}/summary`)).body;
    expect(summary.collectedPaise).toBe(0);
  });

  gsIt('tells the shop when a refund could not be made', async () => {
    const { shop, owner } = await shopWithPayments();
    await paidOrder(shop);
    const [order] = (await queue(owner, shop.shopId)).body.orders;
    const { GatewayError } = await import('../src/platform/payments/index.js');
    fake.state.refundError = new GatewayError('Your account balance is too low', {
      status: 400,
      retryable: false,
    });

    await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'reject', reason: 'Out of paper' });
    await until(
      async () =>
        (await queue(owner, shop.shopId)).body.orders[0].payment.state === 'refund_failed',
      'refund_failed',
    );

    const summary = (await owner.get(`/api/v1/owner/shops/${shop.shopId}/summary`)).body;
    expect(summary.refundFailed).toBe(1);
    expect(fake.refunds).toHaveLength(0);
  });

  gsIt('keeps trying when the provider is only temporarily down', async () => {
    const { shop, owner } = await shopWithPayments();
    const token = await paidOrder(shop);
    const [order] = (await queue(owner, shop.shopId)).body.orders;
    fake.state.down = true;
    await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'reject', reason: 'Out of paper' });
    await sleep(300);
    await ctx.container.payments.sweep();
    expect((await request(ctx.app).get(payUrl(token))).body.payment.state).toBe('paid'); // still being retried

    fake.state.down = false;
    await ctx.container.payments.sweep();
    await until(
      async () => (await request(ctx.app).get(payUrl(token))).body.payment.state === 'refunded',
      'refund after recovery',
    );
    expect(fake.refunds).toHaveLength(1);
  });

  gsIt('does not refund an order that was printed', async () => {
    const { shop, owner } = await shopWithPayments();
    await paidOrder(shop);
    const [order] = (await queue(owner, shop.shopId)).body.orders;
    await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'print' });
    await owner
      .post(`/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/actions`)
      .send({ action: 'complete' });
    await ctx.container.payments.sweep();
    expect(fake.refunds).toHaveLength(0);
    expect((await queue(owner, shop.shopId)).body.orders[0].payment).toMatchObject({
      state: 'paid',
    });
  });
});

describe('platform view', () => {
  it('shows which shops take online payment and in which mode, without any key', async () => {
    const { shop } = await shopWithPayments();
    await seedShop(ctx, 'Plain Prints', 'plain-prints');
    await ctx.container.identity.users.create({
      email: 'root@example.com',
      name: 'Root',
      password: PASSWORD,
      platformRole: 'platform_admin',
    });
    const admin = await signIn('root@example.com');
    const list = await admin.get('/api/v1/admin/shops');
    const a = list.body.shops.find((s: { id: string }) => s.id === shop.shopId);
    const b = list.body.shops.find((s: { slug: string }) => s.slug === 'plain-prints');
    expect(a.onlinePayments).toEqual({ enabled: true, mode: 'test' });
    expect(b.onlinePayments).toEqual({ enabled: false, mode: null });
    expect(JSON.stringify(list.body)).not.toContain(GOOD_KEYS.keySecret);
  });
});
