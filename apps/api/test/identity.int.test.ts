import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, PASSWORD, resetDatabase, seedShop } from './helpers.js';

const ctx = createTestContext();

beforeEach(() => resetDatabase(ctx.db));
afterAll(() => ctx.close());

async function login(email: string, password = PASSWORD) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password });
  return { agent, res };
}

describe('login', () => {
  it('signs in, sets an httpOnly session cookie, and never leaks the password hash', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { res } = await login(shop.ownerEmail);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(shop.ownerEmail);
    expect(JSON.stringify(res.body)).not.toMatch(/hash|argon/i);

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^pp_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('normalises email case and whitespace', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { res } = await login(`  ${shop.ownerEmail.toUpperCase()} `);
    expect(res.status).toBe(200);
  });

  it('returns the same error for a wrong password and an unknown email', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const wrongPassword = await login(shop.ownerEmail, 'not-the-password');
    const unknownEmail = await login('nobody@example.com');

    expect(wrongPassword.res.status).toBe(401);
    expect(unknownEmail.res.status).toBe(401);
    expect(wrongPassword.res.body).toEqual(unknownEmail.res.body);
  });

  it('rejects malformed input with 400', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'nope' });
    expect(res.status).toBe(400);
  });

  it('refuses disabled accounts', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await ctx.db.user.update({ where: { id: shop.ownerId }, data: { isActive: false } });
    const { res } = await login(shop.ownerEmail);
    expect(res.status).toBe(401);
  });

  it('stores passwords as argon2id hashes, never plain text', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: shop.ownerId } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
  });

  it('stores only a hash of the session token', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { res } = await login(shop.ownerEmail);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    const token = /pp_session=([^;]+)/.exec(cookie)![1]!;

    const sessions = await ctx.db.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).not.toBe(token);
    expect(sessions[0]!.tokenHash).not.toContain(token);
  });
});

describe('session lifecycle', () => {
  it('/me requires sign-in', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('/me returns the signed-in user', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await login(shop.ownerEmail);
    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(shop.ownerId);
  });

  it('logout invalidates the session even if the cookie is replayed', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent, res } = await login(shop.ownerEmail);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    const replay = await request(ctx.app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await login(shop.ownerEmail);
    await ctx.db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('stops honouring sessions once the user is disabled', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    const { agent } = await login(shop.ownerEmail);
    await ctx.db.user.update({ where: { id: shop.ownerId }, data: { isActive: false } });
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a forged cookie', async () => {
    const res = await request(ctx.app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'pp_session=totally-made-up');
    expect(res.status).toBe(401);
  });
});

describe('abuse protection', () => {
  it('rate-limits repeated login attempts', async () => {
    const limited = createTestContext({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await request(limited.app)
          .post('/api/v1/auth/login')
          .send({ email: 'nobody@example.com', password: 'whatever-password' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('blocks state-changing requests from a foreign Origin', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.com', password: 'whatever-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('bad_origin');
  });

  it('allows requests from the app origin', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'a@example.com', password: 'whatever-password' });
    expect(res.status).toBe(401);
  });
});

describe('user creation', () => {
  it('rejects duplicate emails and weak passwords', async () => {
    await ctx.container.identity.users.create({
      email: 'dup@example.com',
      name: 'Dup',
      password: PASSWORD,
    });
    await expect(
      ctx.container.identity.users.create({
        email: 'DUP@example.com',
        name: 'Dup',
        password: PASSWORD,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      ctx.container.identity.users.create({
        email: 'new@example.com',
        name: 'New',
        password: 'short',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('audit trail', () => {
  it('records successful and failed logins', async () => {
    const shop = await seedShop(ctx, 'Alpha Prints', 'alpha-prints');
    await login(shop.ownerEmail, 'wrong-password-here');
    await login(shop.ownerEmail);

    const actions = (await ctx.db.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'shop.created',
        'shop.member_added',
        'auth.login_failed',
        'auth.login',
      ]),
    );
  });
});
