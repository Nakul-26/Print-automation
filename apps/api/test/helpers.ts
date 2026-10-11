import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { loadApiEnv } from '@print/config';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/composition.js';
import { createDb, type Db } from '../src/platform/db/client.js';
import { createLogger } from '../src/platform/observability/logger.js';
import { TEST_DATABASE_URL } from './test-env.js';

export const PASSWORD = 'correct-horse-battery';

/** Simple round prices so expected amounts are easy to check by hand. */
export const TEST_RATES = {
  minimumChargePaise: 200,
  rates: [
    { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 200 },
    { paperSize: 'A4', colorMode: 'black_white', sides: 'double', pricePerSidePaise: 150 },
    { paperSize: 'A4', colorMode: 'color', sides: 'single', pricePerSidePaise: 1000 },
  ],
} as const;

export interface TestContext {
  app: Express;
  db: Db;
  container: Container;
  storageRoot: string;
  /** Stops background work, closes the database, and deletes the temp storage directory. */
  close(): Promise<void>;
}

export function createTestContext(overrides: Record<string, string> = {}): TestContext {
  const ownsStorage = overrides['STORAGE_ROOT'] === undefined;
  const storageRoot = overrides['STORAGE_ROOT'] ?? mkdtempSync(join(tmpdir(), 'print-test-'));
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    LOGIN_RATE_LIMIT_MAX: '1000',
    ORDER_RATE_LIMIT_MAX: '1000',
    ESTIMATE_RATE_LIMIT_MAX: '1000',
    UPLOAD_RATE_LIMIT_MAX: '1000',
    STORAGE_ROOT: storageRoot,
    GS_COMMAND: process.env['GS_COMMAND'] ?? 'gs',
    OFFICE_COMMAND: process.env['OFFICE_COMMAND'] ?? 'python3 /opt/print-convert/convert.py',
    ...overrides,
  });
  const logger = createLogger(process.env['TEST_LOG_LEVEL'] ?? 'silent');
  const db = createDb(env.DATABASE_URL);
  const container = createContainer({ env, logger, db });
  const app = createApp({ env, logger, container, readinessChecks: [] });
  return {
    app,
    db,
    container,
    storageRoot,
    async close() {
      await container.stop();
      await db.$disconnect();
      if (ownsStorage) rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE audit_log, order_items, orders, order_counters, uploads, shop_rates, shop_pricing, sessions, shop_members, shops, users RESTART IDENTITY CASCADE',
  );
}

export interface SeededShop {
  shopId: string;
  slug: string;
  ownerId: string;
  ownerEmail: string;
}

/** Creates a shop with an owner account (password = PASSWORD). */
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
  await ctx.container.pricing.setRates(shop.id, structuredClone(TEST_RATES) as never);
  return { shopId: shop.id, slug, ownerId: owner.id, ownerEmail: email };
}
