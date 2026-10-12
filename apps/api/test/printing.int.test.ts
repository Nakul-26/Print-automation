import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT, type AgentPrinter, type PrintJobSpec } from '@print/contracts';
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
let server: Server;
let url: string;
let gsOk = false;

beforeAll(async () => {
  gsOk = await gsAvailable();
  ctx = createTestContext({ PAIRING_FAILURES_MAX: '1000' });
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

const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (t) => {
    if (!gsOk) t.skip();
    await fn();
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const BASE_SETTINGS = {
  pageSelection: 'all',
  copies: 1,
  colorMode: 'black_white',
  sides: 'single',
  paperSize: 'A4',
  pagesPerSheet: 1,
} as const;

const PRINTERS: AgentPrinter[] = [
  { name: 'HP LaserJet', isColor: false, supportsDuplex: true, isDefault: true, offline: false },
  { name: 'Epson L3250', isColor: true, supportsDuplex: true, isDefault: false, offline: false },
  {
    name: 'Microsoft Print to PDF',
    isColor: true,
    supportsDuplex: false,
    isDefault: false,
    offline: false,
  },
];

async function placeOrder(slug: string, settings: object = {}) {
  const up = await request(ctx.app)
    .post(`/api/v1/shops/${slug}/uploads`)
    .attach('file', await makePdf(3), { filename: 'notes.pdf', contentType: 'application/pdf' });
  expect(up.status).toBe(201);
  await until(
    async () =>
      (await request(ctx.app).get(`/api/v1/uploads/${up.body.token}`)).body.status === 'ready',
    'upload',
  );
  const res = await request(ctx.app)
    .post(`/api/v1/shops/${slug}/orders`)
    .send({
      customerName: 'Asha',
      items: [{ uploadToken: up.body.token, settings: { ...BASE_SETTINGS, ...settings } }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const lookupToken = res.body.lookupToken as string;
  await until(
    async () =>
      (await request(ctx.app).get(`/api/v1/orders/${lookupToken}`)).body.status === 'pending',
    'order to become pending',
  );
  return lookupToken;
}

type Owner = ReturnType<typeof request.agent>;
async function signIn(shop: SeededShop): Promise<Owner> {
  const owner = request.agent(ctx.app);
  const res = await owner
    .post('/api/v1/auth/login')
    .send({ email: shop.ownerEmail, password: PASSWORD });
  expect(res.status).toBe(200);
  return owner;
}

const printingUrl = (shop: SeededShop, path = '') =>
  `/api/v1/owner/shops/${shop.shopId}/printing${path}`;
const queueOf = async (owner: Owner, shop: SeededShop) =>
  (await owner.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).body.orders as {
    id: string;
    status: string;
    print: { state: string; error: string | null; agentOnline: boolean } | null;
  }[];
const act = (owner: Owner, shop: SeededShop, orderId: string, body: object) =>
  owner.post(`/api/v1/owner/shops/${shop.shopId}/orders/${orderId}/actions`).send(body);

/** Pairs a (fake) printing app with the shop, the way the real one does. */
async function pairAgent(owner: Owner, shop: SeededShop, deviceName = 'Counter PC') {
  const code = await owner.post(printingUrl(shop, '/pairing'));
  expect(code.status).toBe(201);
  const paired = await request(ctx.app)
    .post('/api/v1/agent/pair')
    .send({ code: code.body.code, deviceName, version: '1.0.0' });
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  return paired.body as { deviceId: string; token: string; shopName: string };
}

/** A stand-in for the printing app on the shop PC: speaks the real protocol, prints nothing. */
class FakeAgent {
  jobs: PrintJobSpec[] = [];
  revoked = false;
  private constructor(
    readonly socket: Socket,
    readonly token: string,
  ) {
    socket.on(AGENT.jobNew, (job: PrintJobSpec) => this.jobs.push(job));
    socket.on(AGENT.revoked, () => (this.revoked = true));
  }
  static async connect(token: string): Promise<FakeAgent> {
    const socket = connect(`${url}${AGENT.namespace}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return new FakeAgent(socket, token);
  }
  emit(event: string, payload: unknown) {
    return new Promise<{ ok: boolean; error?: string }>((resolve) =>
      this.socket.emit(event, payload, resolve),
    );
  }
  hello(printers: AgentPrinter[] = PRINTERS) {
    return this.emit(AGENT.hello, { version: '1.0.0', printers });
  }
  status(jobId: string, status: 'printing' | 'done' | 'failed', error?: string) {
    return this.emit(AGENT.jobStatus, { jobId, status, ...(error ? { error } : {}) });
  }
  download(jobId: string) {
    return request(ctx.app)
      .get(`/api/v1/agent/jobs/${jobId}/file`)
      .set('Authorization', `Bearer ${this.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }
  async nextJob(): Promise<PrintJobSpec> {
    return until(async () => this.jobs.shift(), 'a print job');
  }
  close() {
    this.socket.disconnect();
  }
}

const agents: FakeAgent[] = [];
const open = async (token: string) => {
  const agent = await FakeAgent.connect(token);
  agents.push(agent);
  return agent;
};
afterEach(() => {
  agents.splice(0).forEach((a) => a.close());
});

describe('pairing', () => {
  it('trades a six-digit code for a device token, once', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const code = await owner.post(printingUrl(shop, '/pairing'));
    expect(code.body.code).toMatch(/^\d{6}$/);
    expect(new Date(code.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const pair = (c: string) =>
      request(ctx.app).post('/api/v1/agent/pair').send({ code: c, deviceName: 'PC', version: '1' });
    const first = await pair(code.body.code);
    expect(first.status).toBe(201);
    expect(first.body.shopName).toBe('Alpha Prints');
    expect(first.body.token.length).toBeGreaterThan(30);

    const again = await pair(code.body.code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invalid_code');
  });

  it('refuses expired and malformed codes', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const code = await owner.post(printingUrl(shop, '/pairing'));
    await ctx.db.agentPairing.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const pair = (c: string) =>
      request(ctx.app).post('/api/v1/agent/pair').send({ code: c, deviceName: 'PC', version: '1' });
    expect((await pair(code.body.code)).status).toBe(400);
    expect((await pair('12345')).status).toBe(400); // not six digits
    expect((await pair('abcdef')).status).toBe(400);
  });

  it('stops a stranger who keeps guessing codes, even if a later guess is right', async () => {
    const limited = createTestContext({ PAIRING_FAILURES_MAX: '3' });
    try {
      const shop = await seedShop(limited, 'Alpha Prints', 'alpha-prints');
      const owner = request.agent(limited.app);
      await owner.post('/api/v1/auth/login').send({ email: shop.ownerEmail, password: PASSWORD });
      const real = await owner.post(printingUrl(shop, '/pairing'));
      const wrong = real.body.code === '000000' ? '000001' : '000000';

      const pair = (c: string) =>
        request(limited.app)
          .post('/api/v1/agent/pair')
          .send({ code: c, deviceName: 'PC', version: '1' });
      const answers = [];
      for (let i = 0; i < 5; i++) answers.push((await pair(wrong)).status);
      expect(answers).toEqual([400, 400, 400, 429, 429]);
      expect((await pair(real.body.code)).status).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('only the owner can create codes, and only for their own shop', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const betaOwner = await signIn(beta);
    expect((await betaOwner.post(printingUrl(alpha, '/pairing'))).status).toBe(404);
    expect((await betaOwner.get(printingUrl(alpha))).status).toBe(404);
    expect((await request(ctx.app).post(printingUrl(alpha, '/pairing'))).status).toBe(401);
  });

  it('a new pairing replaces the shop’s previous printing app', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const oldDevice = await pairAgent(owner, shop, 'Old PC');
    const oldAgent = await open(oldDevice.token);
    await pairAgent(owner, shop, 'New PC');

    await until(async () => oldAgent.revoked, 'the old app to be told it was replaced');
    await expect(FakeAgent.connect(oldDevice.token)).rejects.toThrow();
    const status = (await owner.get(printingUrl(shop))).body;
    expect(status.agent.name).toBe('New PC');
  });
});

describe('the agent connection', () => {
  it('rejects missing, wrong, and removed device tokens', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    await expect(FakeAgent.connect('nonsense')).rejects.toThrow();

    const device = await pairAgent(owner, shop);
    const live = await open(device.token);
    expect((await live.hello()).ok).toBe(true);
    expect((await owner.delete(printingUrl(shop, `/agents/${device.deviceId}`))).status).toBe(204);
    await until(async () => live.revoked, 'the removed app to be told');
    await expect(FakeAgent.connect(device.token)).rejects.toThrow();
  });

  it('shows the printers it reports and assigns them on its own', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);

    const before = (await owner.get(printingUrl(shop))).body;
    expect(before.agent.connected).toBe(true);
    expect(before.ready).toBe(false);

    expect((await agent.hello()).ok).toBe(true);
    const status = (await owner.get(printingUrl(shop))).body;
    expect(status.ready).toBe(true);
    expect(status.mapping.black_white.printerName).toBe('HP LaserJet');
    expect(status.mapping.color.printerName).toBe('Epson L3250');
    expect(status.printers).toHaveLength(3);
  });

  it('lets the owner choose printers, but only ones the PC really has', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();

    const swap = await owner.put(printingUrl(shop, '/mapping')).send({
      black_white: { printerName: 'Epson L3250', supportsDuplex: false },
      color: { printerName: 'Epson L3250', supportsDuplex: true },
    });
    expect(swap.status).toBe(200);
    expect(swap.body.mapping.black_white).toMatchObject({
      printerName: 'Epson L3250',
      supportsDuplex: false,
    });
    const bogus = await owner.put(printingUrl(shop, '/mapping')).send({
      black_white: { printerName: 'Not Installed', supportsDuplex: true },
      color: null,
    });
    expect(bogus.status).toBe(400);
  });

  it('keeps the job file private to the shop the job belongs to', async () => {
    if (!gsOk) return;
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const alphaOwner = await signIn(alpha);
    const betaOwner = await signIn(beta);
    const alphaAgent = await open((await pairAgent(alphaOwner, alpha)).token);
    const betaAgent = await open((await pairAgent(betaOwner, beta)).token);
    await alphaAgent.hello();
    await betaAgent.hello();

    await placeOrder('alpha-prints');
    const [order] = await queueOf(alphaOwner, alpha);
    expect((await act(alphaOwner, alpha, order!.id, { action: 'print' })).status).toBe(200);
    const job = await alphaAgent.nextJob();

    expect((await alphaAgent.download(job.id)).status).toBe(200);
    expect((await betaAgent.download(job.id)).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/agent/jobs/${job.id}/file`)).status).toBe(401);
    expect((await betaAgent.status(job.id, 'done')).ok).toBe(false);
    // Alpha's order is untouched by Beta's attempt.
    expect((await queueOf(alphaOwner, alpha))[0]!.status).toBe('printing');
  });
});

describe('printing an order', () => {
  gsIt('sends the right printer and settings, then completes the order when printed', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();

    await placeOrder('alpha-prints', { colorMode: 'color', copies: 3 });
    const [order] = await queueOf(owner, shop);
    const res = await act(owner, shop, order!.id, { action: 'print' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('printing');

    const job = await agent.nextJob();
    expect(job).toMatchObject({
      kind: 'order',
      printerName: 'Epson L3250',
      color: true,
      duplex: 'none',
      copies: 3,
      paperSize: 'A4',
    });
    expect(job.label).toContain('P001');

    const file = await agent.download(job.id);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    expect((await agent.status(job.id, 'printing')).ok).toBe(true);
    expect((await queueOf(owner, shop))[0]).toMatchObject({
      status: 'printing',
      print: { state: 'printing' },
    });

    expect((await agent.status(job.id, 'done')).ok).toBe(true);
    expect((await agent.status(job.id, 'done')).ok).toBe(true); // repeats are harmless
    const [done] = await queueOf(owner, shop);
    expect(done).toMatchObject({ status: 'completed', print: { state: 'done' } });
  });

  gsIt('prints black-and-white orders on the black-and-white printer, single-sided', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();
    await placeOrder('alpha-prints');
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });
    expect(await agent.nextJob()).toMatchObject({
      printerName: 'HP LaserJet',
      color: false,
      duplex: 'none',
      copies: 1,
    });
  });

  gsIt('holds jobs while the app is offline and delivers them when it returns', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const device = await pairAgent(owner, shop);
    const first = await open(device.token);
    await first.hello();
    first.close();
    await until(
      async () => !(await owner.get(printingUrl(shop))).body.agent.connected,
      'the app to show as offline',
    );

    await placeOrder('alpha-prints');
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });
    expect((await queueOf(owner, shop))[0]!.print).toMatchObject({
      state: 'waiting',
      agentOnline: false,
    });

    const back = await open(device.token);
    await back.hello();
    const job = await back.nextJob();
    expect(job.printerName).toBe('HP LaserJet');
    await back.status(job.id, 'done');
    expect((await queueOf(owner, shop))[0]!.status).toBe('completed');
  });

  gsIt('reports a failure to the owner and prints again on retry', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();
    await placeOrder('alpha-prints');
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });

    const job = await agent.nextJob();
    await agent.status(job.id, 'failed', 'Out of paper');
    expect((await queueOf(owner, shop))[0]).toMatchObject({
      status: 'printing',
      print: { state: 'failed', error: 'Out of paper' },
    });

    const retry = await act(owner, shop, order!.id, { action: 'retry_print' });
    expect(retry.status).toBe(200);
    const again = await agent.nextJob();
    expect(again.id).toBe(job.id);
    await agent.status(again.id, 'done');
    expect((await queueOf(owner, shop))[0]!.status).toBe('completed');
  });

  gsIt('lets the owner give up on the app and print by hand', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();
    await placeOrder('alpha-prints');
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });
    const job = await agent.nextJob();
    await agent.status(job.id, 'failed', 'Printer offline');

    const manual = await act(owner, shop, order!.id, { action: 'print_manually' });
    expect(manual.body).toMatchObject({ status: 'printing', print: null });
    // A late answer for the cancelled job changes nothing.
    await agent.status(job.id, 'done');
    expect((await queueOf(owner, shop))[0]!.status).toBe('printing');
    // The manual route still works.
    expect((await act(owner, shop, order!.id, { action: 'complete' })).body.status).toBe(
      'completed',
    );
  });

  gsIt(
    'does nothing special without a printing app: the order just moves to printing',
    async () => {
      const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
      const owner = await signIn(shop);
      await placeOrder('alpha-prints');
      const [order] = await queueOf(owner, shop);
      const res = await act(owner, shop, order!.id, { action: 'print' });
      expect(res.body).toMatchObject({ status: 'printing', print: null });
      expect(await ctx.db.printJob.count()).toBe(0);
    },
  );

  gsIt('explains a two-sided order sent to a printer that cannot duplex', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();
    await owner.put(printingUrl(shop, '/mapping')).send({
      black_white: { printerName: 'HP LaserJet', supportsDuplex: false },
      color: { printerName: 'Epson L3250', supportsDuplex: true },
    });

    await placeOrder('alpha-prints', { sides: 'double' });
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });
    await until(async () => (await queueOf(owner, shop))[0]!.print?.state === 'failed', 'failure');
    expect((await queueOf(owner, shop))[0]!.print!.error).toMatch(/2-sided/);
    expect(agent.jobs).toHaveLength(0);

    // Turning duplex on and retrying fixes it.
    await owner.put(printingUrl(shop, '/mapping')).send({
      black_white: { printerName: 'HP LaserJet', supportsDuplex: true },
      color: { printerName: 'Epson L3250', supportsDuplex: true },
    });
    await act(owner, shop, order!.id, { action: 'retry_print' });
    expect((await agent.nextJob()).duplex).toBe('long');
  });

  gsIt('fails jobs that the app took but never finished', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();
    await placeOrder('alpha-prints');
    const [order] = await queueOf(owner, shop);
    await act(owner, shop, order!.id, { action: 'print' });
    await agent.nextJob();

    await ctx.db.printJob.updateMany({ data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    const swept = await ctx.container.printing.sweep();
    expect(swept.failed).toBe(1);
    expect((await queueOf(owner, shop))[0]!.print).toMatchObject({ state: 'failed' });
  });
});

describe('test pages', () => {
  it('prints one per assigned printer and cleans up after itself', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    const agent = await open((await pairAgent(owner, shop)).token);
    await agent.hello();

    const res = await owner.post(printingUrl(shop, '/test'));
    expect(res.status).toBe(202);
    expect(res.body.sent).toBe(2);
    const first = await agent.nextJob();
    const second = await agent.nextJob();
    expect([first.printerName, second.printerName].sort()).toEqual(['Epson L3250', 'HP LaserJet']);
    expect([first.kind, second.kind]).toEqual(['test', 'test']);

    const file = await agent.download(first.id);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const key = (await ctx.db.printJob.findUniqueOrThrow({ where: { id: first.id } })).fileKey;
    await agent.status(first.id, 'done');
    expect(await ctx.container.storage.exists(key)).toBe(false);
  });

  it('needs a connected app', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await signIn(shop);
    expect((await owner.post(printingUrl(shop, '/test'))).body.error.code).toBe('no_agent');
    const device = await pairAgent(owner, shop);
    expect((await owner.post(printingUrl(shop, '/test'))).body.error.code).toBe('agent_offline');
    expect(device.deviceId).toBeTruthy();
  });
});
