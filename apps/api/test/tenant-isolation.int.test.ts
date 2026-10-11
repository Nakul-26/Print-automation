import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, PASSWORD, resetDatabase, seedShop } from './helpers.js';

/**
 * Tenant isolation suite. Every phase that adds a shop-owned resource (orders, files,
 * rates, printers, ...) must add its cross-shop cases here.
 */
const ctx = createTestContext();

beforeEach(() => resetDatabase(ctx.db));
afterAll(() => ctx.close());

async function signIn(email: string) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

describe('shop listing', () => {
  it('shows each owner only their own shop', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const b = await seedShop(ctx, 'Beta Copies', 'beta-copies');

    const listA = await (await signIn(a.ownerEmail)).get('/api/v1/owner/shops');
    const listB = await (await signIn(b.ownerEmail)).get('/api/v1/owner/shops');

    expect(listA.body.shops.map((s: { id: string }) => s.id)).toEqual([a.shopId]);
    expect(listB.body.shops.map((s: { id: string }) => s.id)).toEqual([b.shopId]);
  });

  it('requires sign-in', async () => {
    const res = await request(ctx.app).get('/api/v1/owner/shops');
    expect(res.status).toBe(401);
  });
});

describe('shop access by id', () => {
  it('lets an owner read their own shop', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const res = await (await signIn(a.ownerEmail)).get(`/api/v1/owner/shops/${a.shopId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.shopId, slug: 'alpha-prints', role: 'owner' });
  });

  it("does not let owner A read shop B, and the answer is indistinguishable from 'no such shop'", async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const b = await seedShop(ctx, 'Beta Copies', 'beta-copies');
    const agentA = await signIn(a.ownerEmail);

    const real = await agentA.get(`/api/v1/owner/shops/${b.shopId}`);
    const missing = await agentA.get(`/api/v1/owner/shops/${randomUUID()}`);
    const malformed = await agentA.get('/api/v1/owner/shops/not-a-uuid');

    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(real.body).toEqual(missing.body);
    expect(JSON.stringify(real.body)).not.toContain('beta');
  });

  it('requires sign-in for shop routes', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const res = await request(ctx.app).get(`/api/v1/owner/shops/${a.shopId}`);
    expect(res.status).toBe(401);
  });

  it('ignores attempts to switch shop via headers or query strings', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const b = await seedShop(ctx, 'Beta Copies', 'beta-copies');
    const agentA = await signIn(a.ownerEmail);

    const res = await agentA
      .get(`/api/v1/owner/shops/${b.shopId}?shopId=${a.shopId}`)
      .set('X-Shop-Id', a.shopId);
    expect(res.status).toBe(404);
  });
});

describe('roles and status', () => {
  it('does not give a platform admin implicit access to shops they are not a member of', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await ctx.container.identity.users.create({
      email: 'admin@example.com',
      name: 'Admin',
      password: PASSWORD,
      platformRole: 'platform_admin',
    });
    const res = await (await signIn('admin@example.com')).get(`/api/v1/owner/shops/${a.shopId}`);
    expect(res.status).toBe(404);
  });

  it('lets a user with memberships in two shops see both, each with the right role', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const b = await seedShop(ctx, 'Beta Copies', 'beta-copies');
    await ctx.container.shops.addMember({ shopId: b.shopId, userId: a.ownerId, role: 'staff' });

    const agent = await signIn(a.ownerEmail);
    const list = await agent.get('/api/v1/owner/shops');
    const roles = Object.fromEntries(
      list.body.shops.map((s: { id: string; role: string }) => [s.id, s.role]),
    );
    expect(roles).toEqual({ [a.shopId]: 'owner', [b.shopId]: 'staff' });
    expect((await agent.get(`/api/v1/owner/shops/${b.shopId}`)).status).toBe(200);
  });

  it('refuses members of a suspended shop', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints', { status: 'suspended' });
    const res = await (await signIn(a.ownerEmail)).get(`/api/v1/owner/shops/${a.shopId}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('shop_suspended');
  });

  it('applies membership changes immediately (no stale access)', async () => {
    const a = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const agent = await signIn(a.ownerEmail);
    expect((await agent.get(`/api/v1/owner/shops/${a.shopId}`)).status).toBe(200);

    await ctx.db.shopMember.deleteMany({ where: { shopId: a.shopId, userId: a.ownerId } });
    expect((await agent.get(`/api/v1/owner/shops/${a.shopId}`)).status).toBe(404);
  });
});

describe('shop creation rules', () => {
  it('rejects reserved and invalid slugs and duplicates', async () => {
    await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    for (const slug of ['admin', 'API', 'a', 'has space', 'alpha-prints']) {
      await expect(ctx.container.shops.createShop({ name: 'X', slug })).rejects.toMatchObject({
        status: expect.any(Number),
      });
    }
  });
});
