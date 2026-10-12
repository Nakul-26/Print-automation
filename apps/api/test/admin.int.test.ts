import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, REALTIME } from '@print/contracts';
import { makeDocx, makePng } from './fixtures.js';
import {
  createTestContext,
  PASSWORD,
  resetDatabase,
  seedShop,
  type SeededShop,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let server: Server;
let url: string;

beforeAll(async () => {
  ctx = createTestContext({ APPLY_RATE_LIMIT_MAX: '1000' });
  await ctx.container.start();
  server = createServer(ctx.app);
  ctx.container.realtime.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.close();
});
beforeEach(async () => {
  await resetDatabase(ctx.db);
});

const sockets: Socket[] = [];
afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));

const APPLICATION = {
  shopName: 'Gamma Copy Centre',
  slug: 'gamma-copy',
  ownerName: 'Gita Rao',
  email: 'gita@example.com',
  password: 'a-long-enough-password',
  phone: '9876543210',
  address: '12 College Road, Pune',
};

async function signInAs(email: string, password = PASSWORD) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])
    .map((c) => c.split(';')[0]!)
    .join('; ');
  return { agent, cookie };
}

async function adminSession() {
  await ctx.container.identity.users.create({
    email: 'root@example.com',
    name: 'Root',
    password: PASSWORD,
    platformRole: 'platform_admin',
  });
  return (await signInAs('root@example.com')).agent;
}

const upload = (slug: string, file: Buffer, name = 'a.png', type = 'image/png') =>
  request(ctx.app).post(`/api/v1/shops/${slug}/uploads`).attach('file', file, {
    filename: name,
    contentType: type,
  });

const open = async (cookie?: string): Promise<Socket> => {
  const socket = connect(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...(cookie ? { extraHeaders: { cookie } } : {}),
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
};

const closed = (socket: Socket) =>
  new Promise<void>((resolve, reject) => {
    if (socket.disconnected) return resolve();
    const timer = setTimeout(() => reject(new Error('socket stayed connected')), 5000);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });

describe('applying for a shop', () => {
  it('creates an owner account and a pending shop with starter prices', async () => {
    const res = await request(ctx.app).post('/api/v1/applications').send(APPLICATION);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pending_approval');

    const { agent } = await signInAs(APPLICATION.email, APPLICATION.password);
    const shops = await agent.get('/api/v1/owner/shops');
    expect(shops.body.shops).toHaveLength(1);
    expect(shops.body.shops[0]).toMatchObject({
      slug: 'gamma-copy',
      status: 'pending_approval',
      role: 'owner',
    });
    const rates = await agent.get(`/api/v1/owner/shops/${res.body.shopId}/rates`);
    expect(rates.body.rates.length).toBeGreaterThan(0);

    // Students cannot use the shop until it is approved.
    expect((await upload('gamma-copy', await makePng())).status).toBe(404);
  });

  it('refuses a taken slug, reserved slug, taken email and weak password without leaving junk', async () => {
    await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const apply = (over: object) =>
      request(ctx.app)
        .post('/api/v1/applications')
        .send({ ...APPLICATION, ...over });

    expect((await apply({ slug: 'alpha-prints' })).body.error.code).toBe('slug_taken');
    expect((await apply({ slug: 'admin' })).body.error.code).toBe('invalid_slug');
    expect((await apply({ email: 'owner-alpha-prints@example.com' })).body.error.code).toBe(
      'email_taken',
    );
    expect((await apply({ password: 'short' })).status).toBe(400);
    expect((await apply({ slug: 'Bad Slug!' })).status).toBe(400);

    expect(await ctx.db.user.count({ where: { email: APPLICATION.email } })).toBe(0);
    expect(await ctx.db.shop.count({ where: { slug: 'gamma-copy' } })).toBe(0);
  });

  it('limits how many applications one connection can send', async () => {
    const limited = createTestContext({ APPLY_RATE_LIMIT_MAX: '2' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await request(limited.app)
          .post('/api/v1/applications')
          .send({ ...APPLICATION, slug: `shop-${i}x`, email: `p${i}@example.com` });
        codes.push(res.status);
      }
      expect(codes).toEqual([201, 201, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('who may use the admin API', () => {
  it('needs a platform admin', async () => {
    expect((await request(ctx.app).get('/api/v1/admin/shops')).status).toBe(401);
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await signInAs(shop.ownerEmail);
    expect((await agent.get('/api/v1/admin/shops')).status).toBe(403);
    expect((await agent.get('/api/v1/admin/settings')).status).toBe(403);
    expect((await agent.post(`/api/v1/admin/shops/${shop.shopId}/suspend`)).status).toBe(403);
  });
});

describe('approval and suspension', () => {
  it('lets a student order only after approval, and shows the shop in the right tab', async () => {
    const applied = await request(ctx.app).post('/api/v1/applications').send(APPLICATION);
    const admin = await adminSession();

    const pending = await admin.get('/api/v1/admin/shops?status=pending_approval');
    expect(pending.body.shops).toHaveLength(1);
    expect(pending.body.shops[0]).toMatchObject({
      slug: 'gamma-copy',
      ratesSet: true,
      printingPaired: false,
      owner: { email: 'gita@example.com' },
    });

    const approved = await admin.post(`/api/v1/admin/shops/${applied.body.shopId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('active');
    expect((await upload('gamma-copy', await makePng())).status).toBe(201);
    expect(
      (await admin.get('/api/v1/admin/shops?status=pending_approval')).body.shops,
    ).toHaveLength(0);

    // Approving twice is not a valid move.
    const again = await admin.post(`/api/v1/admin/shops/${applied.body.shopId}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('invalid_transition');
    expect((await admin.post(`/api/v1/admin/shops/${applied.body.shopId}/reactivate`)).status).toBe(
      409,
    );
  });

  it('records who did what', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const admin = await adminSession();
    await admin.post(`/api/v1/admin/shops/${shop.shopId}/suspend`).send({ reason: 'Unpaid fees' });
    const log = await admin.get(`/api/v1/admin/audit?shopId=${shop.shopId}`);
    const entry = log.body.entries.find((e: { action: string }) => e.action === 'shop.suspended');
    expect(entry.metadata).toMatchObject({
      from: 'active',
      to: 'suspended',
      reason: 'Unpaid fees',
    });
  });

  it('cuts off the owner, the students and the printing app at once, and reactivation restores them', async () => {
    const shop: SeededShop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent: owner, cookie } = await signInAs(shop.ownerEmail);
    const admin = await adminSession();

    // A live dashboard connection and a paired, connected printing app.
    const dashboard = await open(cookie);
    expect(
      (
        await new Promise<{ ok: boolean }>((r) =>
          dashboard.emit(REALTIME.watchShop, { shopId: shop.shopId }, r),
        )
      ).ok,
    ).toBe(true);
    const code = await owner.post(`/api/v1/owner/shops/${shop.shopId}/printing/pairing`);
    const paired = await request(ctx.app)
      .post('/api/v1/agent/pair')
      .send({ code: code.body.code, deviceName: 'PC', version: '1.0.0' });
    const connectAgent = () =>
      new Promise<Socket>((resolve, reject) => {
        const s = connect(`${url}${AGENT.namespace}`, {
          auth: { token: paired.body.token },
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
        });
        sockets.push(s);
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
    const printingApp = await connectAgent();
    await new Promise((r) => setTimeout(r, 300)); // the server joins the app to its rooms

    const res = await admin.post(`/api/v1/admin/shops/${shop.shopId}/suspend`).send({});
    expect(res.body.status).toBe('suspended');

    await Promise.all([closed(dashboard), closed(printingApp)]);

    // Everything stays shut while suspended.
    const queue = await owner.get(`/api/v1/owner/shops/${shop.shopId}/orders`);
    expect(queue.status).toBe(403);
    expect(queue.body.error.code).toBe('shop_suspended');
    expect((await upload('alpha-prints', await makePng())).status).toBe(404);
    await expect(connectAgent()).rejects.toThrow('unauthorized');
    const download = await request(ctx.app)
      .get('/api/v1/agent/jobs/00000000-0000-4000-8000-000000000000/file')
      .set('Authorization', `Bearer ${paired.body.token}`);
    expect(download.status).toBe(401);
    // The owner can still sign in and see that the shop is suspended.
    expect((await owner.get('/api/v1/owner/shops')).body.shops[0].status).toBe('suspended');

    // Reactivating brings everything back, with the same printing app token.
    expect((await admin.post(`/api/v1/admin/shops/${shop.shopId}/reactivate`)).body.status).toBe(
      'active',
    );
    expect((await owner.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).status).toBe(200);
    expect((await upload('alpha-prints', await makePng())).status).toBe(201);
    await expect(connectAgent()).resolves.toBeDefined();
  });
});

describe('storage limits', () => {
  it('stops one shop at its own cap without affecting another shop', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const admin = await adminSession();
    const png = await makePng();

    expect((await upload('alpha-prints', png)).status).toBe(201);
    const set = await admin
      .patch(`/api/v1/admin/shops/${alpha.shopId}`)
      .send({ storageQuotaBytes: 1000 });
    expect(set.status).toBe(200);
    expect(set.body.storageQuotaBytes).toBe(1000);

    const blocked = await upload('alpha-prints', png);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('shop_storage_full');
    expect((await upload('beta-prints', png)).status).toBe(201);

    const lifted = await admin
      .patch(`/api/v1/admin/shops/${alpha.shopId}`)
      .send({ storageQuotaBytes: null });
    expect(lifted.body.storageQuotaBytes).toBeNull();
    expect((await upload('alpha-prints', png)).status).toBe(201);

    const list = await admin.get('/api/v1/admin/shops');
    const row = list.body.shops.find((s: { slug: string }) => s.slug === 'alpha-prints');
    expect(row.storageBytes).toBeGreaterThan(0);
  });

  it('applies a new platform limit immediately, without a restart', async () => {
    await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const admin = await adminSession();
    const png = await makePng();

    const before = await admin.get('/api/v1/admin/settings');
    expect(before.body.storageMaxBytes).toBe(before.body.defaultStorageMaxBytes);

    // Too small a value is refused (it would lock every shop out).
    expect((await admin.put('/api/v1/admin/settings').send({ storageMaxBytes: 1000 })).status).toBe(
      400,
    );

    const floor = 100 * 1024 ** 2;
    const saved = await admin.put('/api/v1/admin/settings').send({ storageMaxBytes: floor });
    expect(saved.body.storageMaxBytes).toBe(floor);
    expect((await upload('alpha-prints', png)).status).toBe(201);

    // The same code path with a tiny limit (below what the API accepts) shuts uploads.
    await ctx.container.settings.setStorageMaxBytes(1000, null);
    const full = await upload('alpha-prints', png);
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe('storage_full');
    await ctx.container.settings.setStorageMaxBytes(floor, null);
    expect((await upload('alpha-prints', png)).status).toBe(201);
  });
});

describe('per-shop switches', () => {
  it('can turn off Office files for one shop only', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const admin = await adminSession();
    const docx = await makeDocx(5);
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    const off = await admin
      .patch(`/api/v1/admin/shops/${alpha.shopId}`)
      .send({ flags: { officeFiles: false } });
    expect(off.body.flags.officeFiles).toBe(false);

    const refused = await upload('alpha-prints', docx, 'a.docx', DOCX);
    expect(refused.status).toBe(415);
    expect(refused.body.error.message).toMatch(/PDF and image/);
    expect((await upload('alpha-prints', await makePng())).status).toBe(201);
    expect((await upload('beta-prints', docx, 'a.docx', DOCX)).status).toBe(201);
  });
});
