import type { Express } from 'express';
import { loadApiEnv } from '@print/config';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/composition.js';
import { createDb, type Db } from '../src/platform/db/client.js';
import { createLogger } from '../src/platform/observability/logger.js';
import { TEST_DATABASE_URL } from './test-env.js';

export const PASSWORD = 'correct-horse-battery';

export interface TestContext {
  app: Express;
  db: Db;
  container: Container;
}

export function createTestContext(overrides: Record<string, string> = {}): TestContext {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    LOGIN_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
  const logger = createLogger('silent' as never);
  const db = createDb(env.DATABASE_URL);
  const container = createContainer({ env, logger, db });
  const app = createApp({ env, logger, container, readinessChecks: [] });
  return { app, db, container };
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE audit_log, sessions, shop_members, shops, users RESTART IDENTITY CASCADE',
  );
}

export interface SeededShop {
  shopId: string;
  slug: string;
  ownerId: string;
  ownerEmail: string;
}

/** Creates an active shop with an owner account (password = PASSWORD). */
export async function seedShop(
  ctx: TestContext,
  name: string,
  slug: string,
  opts: { status?: 'active' | 'pending_approval' | 'suspended' } = {},
): Promise<SeededShop> {
  const email = `owner-${slug}@example.com`;
  const owner = await ctx.container.identity.users.create({
    email,
    name: `${name} Owner`,
    password: PASSWORD,
  });
  const shop = await ctx.container.shops.createShop({
    name,
    slug,
    status: opts.status ?? 'active',
  });
  await ctx.container.shops.addMember({ shopId: shop.id, userId: owner.id, role: 'owner' });
  return { shopId: shop.id, slug, ownerId: owner.id, ownerEmail: email };
}
