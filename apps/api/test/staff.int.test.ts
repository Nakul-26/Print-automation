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

async function signInWith(email: string, password: string) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  return { agent, status: res.status };
}

async function ownerOf(shop: SeededShop) {
  const { agent, status } = await signInWith(shop.ownerEmail, PASSWORD);
  expect(status).toBe(200);
  return agent;
}

const staffUrl = (shopId: string, rest = '') => `/api/v1/owner/shops/${shopId}/staff${rest}`;

describe('adding staff', () => {
  it('creates an account with a one-time password that lets them into the queue, but not the owner’s tools', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);

    const added = await owner
      .post(staffUrl(shop.shopId))
      .send({ name: 'Ravi Kumar', email: 'Ravi@Example.com' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.existingAccount).toBe(false);
    expect(added.body.password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(added.body.member).toMatchObject({
      name: 'Ravi Kumar',
      email: 'ravi@example.com',
      role: 'staff',
    });

    const { agent: staff, status } = await signInWith('ravi@example.com', added.body.password);
    expect(status).toBe(200);

    // They see the shop and its queue ...
    expect((await staff.get('/api/v1/owner/shops')).body.shops[0]).toMatchObject({
      slug: 'alpha-prints',
      role: 'staff',
    });
    expect((await staff.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).status).toBe(200);
    // ... but cannot manage people or prices.
    expect((await staff.get(staffUrl(shop.shopId))).status).toBe(403);
    expect(
      (
        await staff
          .post(staffUrl(shop.shopId))
          .send({ name: 'Eve Mallory', email: 'eve@example.com' })
      ).status,
    ).toBe(403);
    expect(
      (
        await staff
          .put(`/api/v1/owner/shops/${shop.shopId}/rates`)
          .send({ rates: [], minimumChargePaise: 0 })
      ).status,
    ).toBe(403);
  });

  it('lists the owner first, and links an existing account without touching its password', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const owner = await ownerOf(alpha);

    const added = await owner
      .post(staffUrl(alpha.shopId))
      .send({ name: 'Beta Owner', email: beta.ownerEmail });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ existingAccount: true, password: null });

    const list = await owner.get(staffUrl(alpha.shopId));
    expect(list.body.members.map((m: { role: string }) => m.role)).toEqual(['owner', 'staff']);
    // Their own password still works.
    expect((await signInWith(beta.ownerEmail, PASSWORD)).status).toBe(200);
  });

  it('refuses a duplicate and bad input', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);
    const body = { name: 'Ravi Kumar', email: 'ravi@example.com' };

    expect((await owner.post(staffUrl(shop.shopId)).send(body)).status).toBe(201);
    expect((await owner.post(staffUrl(shop.shopId)).send(body)).status).toBe(409);
    expect(
      (await owner.post(staffUrl(shop.shopId)).send({ ...body, email: shop.ownerEmail })).status,
    ).toBe(409);
    expect(
      (await owner.post(staffUrl(shop.shopId)).send({ name: 'R', email: 'x@example.com' })).status,
    ).toBe(400);
    expect(
      (await owner.post(staffUrl(shop.shopId)).send({ name: 'Ravi Kumar', email: 'nope' })).status,
    ).toBe(400);
  });

  it('never lets another shop’s owner see or change this shop’s people', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const betaOwner = await ownerOf(beta);

    expect((await betaOwner.get(staffUrl(alpha.shopId))).status).toBe(404);
    expect(
      (
        await betaOwner
          .post(staffUrl(alpha.shopId))
          .send({ name: 'Eve Mallory', email: 'eve@example.com' })
      ).status,
    ).toBe(404);
    expect((await signInWith('eve@example.com', 'whatever-password')).status).toBe(401);
  });

  it('needs sign-in and records the change without the password', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    expect((await request(ctx.app).get(staffUrl(shop.shopId))).status).toBe(401);

    const owner = await ownerOf(shop);
    const added = await owner
      .post(staffUrl(shop.shopId))
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    const log = await ctx.db.auditLog.findMany({ where: { action: 'shop.staff_added' } });
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain(added.body.password);
  });
});

describe('removing staff', () => {
  it('takes access away immediately, even for someone already signed in', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);
    const added = await owner
      .post(staffUrl(shop.shopId))
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    const { agent: staff } = await signInWith('ravi@example.com', added.body.password);
    expect((await staff.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).status).toBe(200);

    expect((await owner.delete(staffUrl(shop.shopId, `/${added.body.member.userId}`))).status).toBe(
      204,
    );

    expect((await staff.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).status).toBe(404);
    expect((await owner.get(staffUrl(shop.shopId))).body.members).toHaveLength(1);
  });

  it('cannot remove the owner, and a staff member cannot remove anyone', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);
    const added = await owner
      .post(staffUrl(shop.shopId))
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    const { agent: staff } = await signInWith('ravi@example.com', added.body.password);

    expect((await owner.delete(staffUrl(shop.shopId, `/${shop.ownerId}`))).status).toBe(409);
    expect((await staff.delete(staffUrl(shop.shopId, `/${shop.ownerId}`))).status).toBe(403);
    expect((await owner.get(staffUrl(shop.shopId))).body.members).toHaveLength(2);
  });
});

describe('resetting a staff password', () => {
  it('gives a new password, ends their sessions, and the old password stops working', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);
    const added = await owner
      .post(staffUrl(shop.shopId))
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com' });
    const { agent: staff } = await signInWith('ravi@example.com', added.body.password);

    const reset = await owner.post(
      staffUrl(shop.shopId, `/${added.body.member.userId}/reset-password`),
    );
    expect(reset.status).toBe(200);
    expect(reset.body.password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(reset.body.password).not.toBe(added.body.password);

    expect((await staff.get(`/api/v1/owner/shops/${shop.shopId}/orders`)).status).toBe(401);
    expect((await signInWith('ravi@example.com', added.body.password)).status).toBe(401);
    expect((await signInWith('ravi@example.com', reset.body.password)).status).toBe(200);
  });

  it('refuses accounts that are also used elsewhere, so no owner can take over someone else’s login', async () => {
    const alpha = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const beta = await seedShop(ctx, 'Beta Prints', 'beta-prints');
    const owner = await ownerOf(alpha);
    // Beta's owner is linked as Alpha staff: Alpha's owner must not be able to reset their password.
    const added = await owner
      .post(staffUrl(alpha.shopId))
      .send({ name: 'Beta Owner', email: beta.ownerEmail });

    const res = await owner.post(
      staffUrl(alpha.shopId, `/${added.body.member.userId}/reset-password`),
    );
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('shared_account');
    expect((await signInWith(beta.ownerEmail, PASSWORD)).status).toBe(200);
  });

  it('refuses owners, strangers and platform admins', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const owner = await ownerOf(shop);

    expect(
      (await owner.post(staffUrl(shop.shopId, `/${shop.ownerId}/reset-password`))).status,
    ).toBe(409);
    expect(
      (
        await owner.post(
          staffUrl(shop.shopId, '/00000000-0000-4000-8000-000000000000/reset-password'),
        )
      ).status,
    ).toBe(404);

    const admin = await ctx.container.identity.users.create({
      email: 'root@example.com',
      name: 'Root',
      password: PASSWORD,
      platformRole: 'platform_admin',
    });
    await owner.post(staffUrl(shop.shopId)).send({ name: 'Root Admin', email: 'root@example.com' });
    expect((await owner.post(staffUrl(shop.shopId, `/${admin.id}/reset-password`))).status).toBe(
      409,
    );
    expect((await signInWith('root@example.com', PASSWORD)).status).toBe(200);
  });
});
