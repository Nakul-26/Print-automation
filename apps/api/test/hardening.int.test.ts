import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

describe('API-wide limit', () => {
  let ctx: TestContext;
  beforeAll(() => {
    ctx = createTestContext({ API_RATE_LIMIT_MAX: '5' });
  });
  afterAll(() => ctx.close());

  it('answers 429 in the usual error shape once a connection goes over its ceiling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await request(ctx.app).get('/api/v1/shops/nowhere-shop')).status);
    }
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const limited = await request(ctx.app).get('/api/v1/shops/nowhere-shop');
    expect(limited.body.error).toMatchObject({ code: 'rate_limited' });
  });

  it('does not limit the health probes', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await request(ctx.app).get('/health')).status).toBe(200);
    }
  });
});

describe('response hygiene', () => {
  let ctx: TestContext;
  beforeAll(() => {
    ctx = createTestContext();
  });
  afterAll(() => ctx.close());

  it('sends security headers and never reveals the stack or framework', async () => {
    const res = await request(ctx.app).get('/api/v1/shops/nowhere-shop');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules|prisma/i);
  });

  it('does not let a stranger tell a missing order from a malformed token', async () => {
    const guess = await request(ctx.app).get(`/api/v1/orders/${'a'.repeat(32)}`);
    const junk = await request(ctx.app).get('/api/v1/orders/not-a-token');
    expect(guess.status).toBe(404);
    expect(junk.status).toBe(404);
    expect(guess.body).toEqual(junk.body);
  });

  it('rejects state-changing requests from another origin', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', password: 'x' });
    expect(res.status).toBe(403);
  });
});
