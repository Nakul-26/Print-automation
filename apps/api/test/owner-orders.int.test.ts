import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REALTIME } from '@print/contracts';
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

/** Places a one-document order and waits until the shop can see it as pending. */
async function placeOrder(slug: string, pages = 3) {
  const up = await request(ctx.app)
    .post(`/api/v1/shops/${slug}/uploads`)
    .attach('file', await makePdf(pages), {
      filename: 'notes.pdf',
      contentType: 'application/pdf',
    });
  expect(up.status).toBe(201);
  await until(async () => {
    const r = await request(ctx.app).get(`/api/v1/uploads/${up.body.token}`);
    return r.body.status === 'ready';
  }, 'upload');
  const res = await request(ctx.app)
    .post(`/api/v1/shops/${slug}/orders`)
    .send({ customerName: 'Asha', items: [{ uploadToken: up.body.token, settings }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const lookupToken = res.body.lookupToken as string;
  await until(async () => {
    const r = await request(ctx.app).get(`/api/v1/orders/${lookupToken}`);
    return r.body.status === 'pending';
  }, 'order to become pending');
  return lookupToken;
}

type Agent = ReturnType<typeof request.agent>;

async function signIn(shop: SeededShop) {
  const agent = request.agent(ctx.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .send({ email: shop.ownerEmail, password: PASSWORD });
  expect(res.status).toBe(200);
  return { agent, cookie: res.headers['set-cookie']![0]!.split(';')[0]! };
}

const queue = (agent: Agent, shopId: string) => agent.get(`/api/v1/owner/shops/${shopId}/orders`);
const act = (agent: Agent, shopId: string, orderId: string, body: object) =>
  agent.post(`/api/v1/owner/shops/${shopId}/orders/${orderId}/actions`).send(body);

describe('owner queue', () => {
  gsIt('lists orders with everything needed to print, in queue order', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await signIn(shop);
    await placeOrder('alpha-prints');
    await placeOrder('alpha-prints');

    const res = await queue(agent, shop.shopId);
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o: { queueNumber: string }) => o.queueNumber)).toEqual([
      'P001',
      'P002',
    ]);
    expect(res.body.orders[0]).toMatchObject({
      status: 'pending',
      customerName: 'Asha',
      estimatedAmountPaise: 600,
      finalAmountPaise: null,
    });
    expect(res.body.orders[0].items[0]).toMatchObject({
      originalName: 'notes.pdf',
      fileReady: true,
      settings: { colorMode: 'black_white', copies: 1 },
    });
  });

  gsIt('prints, then completes with the amount actually collected', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await signIn(shop);
    const token = await placeOrder('alpha-prints');
    const [order] = (await queue(agent, shop.shopId)).body.orders;

    const printing = await act(agent, shop.shopId, order.id, { action: 'print' });
    expect(printing.status).toBe(200);
    expect(printing.body.status).toBe('printing');
    expect((await request(ctx.app).get(`/api/v1/orders/${token}`)).body.status).toBe('printing');

    const done = await act(agent, shop.shopId, order.id, {
      action: 'complete',
      finalAmountPaise: 500,
    });
    expect(done.body).toMatchObject({ status: 'completed', finalAmountPaise: 500 });
    const student = (await request(ctx.app).get(`/api/v1/orders/${token}`)).body;
    expect(student).toMatchObject({ status: 'completed', finalAmountPaise: 500 });
  });

  gsIt('rejects with a reason the student can read, and refuses a second action', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await signIn(shop);
    const token = await placeOrder('alpha-prints');
    const [order] = (await queue(agent, shop.shopId)).body.orders;

    expect((await act(agent, shop.shopId, order.id, { action: 'reject' })).status).toBe(400);
    const rejected = await act(agent, shop.shopId, order.id, {
      action: 'reject',
      reason: 'Out of A3 paper',
    });
    expect(rejected.body.status).toBe('rejected');
    expect((await request(ctx.app).get(`/api/v1/orders/${token}`)).body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Out of A3 paper',
    });

    const again = await act(agent, shop.shopId, order.id, { action: 'print' });
    expect(again.status).toBe(409);
  });

  gsIt('serves the exact print PDF to the shop only', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await signIn(shop);
    await placeOrder('alpha-prints', 4);
    const [order] = (await queue(agent, shop.shopId)).body.orders;
    const url = `/api/v1/owner/shops/${shop.shopId}/orders/${order.id}/items/${order.items[0].id}/file`;

    const file = await agent
      .get(url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['cache-control']).toMatch(/no-store/);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const dl = await agent.get(`${url}?download=1`).buffer(true);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="P001-1\.pdf"$/);

    expect((await request(ctx.app).get(url)).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  gsIt('another shop owner can neither see nor change an order', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const { agent: alphaOwner } = await signIn(alpha);
    const { agent: betaOwner } = await signIn(beta);
    await placeOrder('alpha-prints');
    const [order] = (await queue(alphaOwner, alpha.shopId)).body.orders;

    // Naming Alpha's shop id is refused; naming their own shop with Alpha's order id finds nothing.
    expect((await queue(betaOwner, alpha.shopId)).status).toBe(404);
    expect((await act(betaOwner, alpha.shopId, order.id, { action: 'print' })).status).toBe(404);
    expect((await act(betaOwner, beta.shopId, order.id, { action: 'print' })).status).toBe(404);
    const fileUrl = (shopId: string) =>
      `/api/v1/owner/shops/${shopId}/orders/${order.id}/items/${order.items[0].id}/file`;
    expect((await betaOwner.get(fileUrl(alpha.shopId))).status).toBe(404);
    expect((await betaOwner.get(fileUrl(beta.shopId))).status).toBe(404);

    expect((await queue(betaOwner, beta.shopId)).body.orders).toEqual([]);
    expect((await queue(alphaOwner, alpha.shopId)).body.orders[0].status).toBe('pending');
  });

  it('requires sign-in', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const res = await request(ctx.app).get(`/api/v1/owner/shops/${shop.shopId}/orders`);
    expect(res.status).toBe(401);
  });
});

describe('realtime', () => {
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    server = createServer(ctx.app);
    ctx.container.realtime.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    sockets.forEach((s) => s.disconnect());
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
  const ask = (socket: Socket, event: string, payload: object) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit(event, payload, resolve));
  const nextEvent = (socket: Socket, event: string) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} event`)), 5000);
      socket.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  gsIt('tells the shop about new and changed orders, and the student about theirs', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent, cookie } = await signIn(shop);
    const owner = await open(cookie);
    expect(await ask(owner, REALTIME.watchShop, { shopId: shop.shopId })).toEqual({ ok: true });

    const created = nextEvent(owner, REALTIME.queueChanged);
    const token = await placeOrder('alpha-prints');
    await created;

    const student = await open();
    expect(await ask(student, REALTIME.watchOrder, { token })).toEqual({ ok: true });
    const studentEvent = nextEvent(student, REALTIME.orderChanged);
    const ownerEvent = nextEvent(owner, REALTIME.queueChanged);
    const [order] = (await queue(agent, shop.shopId)).body.orders;
    await act(agent, shop.shopId, order.id, { action: 'print' });
    await studentEvent;
    await ownerEvent;
  });

  it('refuses strangers, other shops, and guessed order tokens', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const { cookie: betaCookie } = await signIn(beta);

    const anonymous = await open();
    expect((await ask(anonymous, REALTIME.watchShop, { shopId: alpha.shopId })).ok).toBe(false);

    const betaOwner = await open(betaCookie);
    expect((await ask(betaOwner, REALTIME.watchShop, { shopId: alpha.shopId })).ok).toBe(false);
    expect((await ask(betaOwner, REALTIME.watchShop, { shopId: 'not-a-uuid' })).ok).toBe(false);

    expect((await ask(anonymous, REALTIME.watchOrder, { token: 'x'.repeat(32) })).ok).toBe(false);
    expect((await ask(anonymous, REALTIME.watchOrder, { token: 5 })).ok).toBe(false);
  });

  it('rejects connections from another origin', async () => {
    const socket = connect(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { origin: 'https://evil.example' },
    });
    sockets.push(socket);
    await expect(
      new Promise((resolve, reject) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', reject);
      }),
    ).rejects.toBeTruthy();
  });
});
