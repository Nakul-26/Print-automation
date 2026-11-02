import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadApiEnv } from '@print/config';
import { createContainer } from './composition.js';
import { DEFAULT_RATES } from './modules/pricing/index.js';
import { createDb } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';

const USAGE = `Usage:
  pnpm --filter @print/api cli create-admin --email <email> --name <name> [--password <pw>]
  pnpm --filter @print/api cli set-default-rates --slug <slug>
  pnpm --filter @print/api cli create-shop --name <shop name> --slug <slug>
        --owner-email <email> --owner-name <name> [--owner-password <pw>] [--pending]
        [--no-default-rates]
  pnpm --filter @print/api cli seed-dev-accounts
        Creates the dummy accounts listed in apps/api/.env.dev-accounts (local databases only).

Passwords are generated and printed once if not supplied. Shops are created active unless --pending, with a starter rate card unless --no-default-rates.`;

const generatePassword = (): string => randomBytes(12).toString('base64url');

/** The roles a developer needs to try the app with. Emails and passwords come from .env.dev-accounts. */
type DevAccountKey = 'ADMIN' | 'OWNER' | 'STAFF' | 'PENDING_OWNER';

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Creates (or resets the password of) one dummy account per role, plus a demo shop, so the app can be
 * tried locally. Refuses to run against anything that does not look like a local development database.
 */
async function seedDevAccounts(
  nodeEnv: string,
  databaseUrl: string,
  container: ReturnType<typeof createContainer>,
): Promise<void> {
  const host = new URL(databaseUrl).hostname;
  if (nodeEnv === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error(
      `Refusing to create dummy accounts: this only runs against a local development database (NODE_ENV=${nodeEnv}, database host "${host}").`,
    );
  }
  const file = new URL('../.env.dev-accounts', import.meta.url);
  if (!existsSync(file)) {
    throw new Error(
      'apps/api/.env.dev-accounts not found. Copy apps/api/.env.dev-accounts.example to .env.dev-accounts and set the passwords.',
    );
  }
  const values = readEnvFile(fileURLToPath(file));
  const account = (key: DevAccountKey) => {
    const email = values[`DEV_${key}_EMAIL`];
    const password = values[`DEV_${key}_PASSWORD`];
    if (!email || !password)
      throw new Error(`.env.dev-accounts is missing DEV_${key}_EMAIL or DEV_${key}_PASSWORD`);
    return { email, password };
  };

  const users = container.identity.users;
  async function ensureUser(key: DevAccountKey, name: string, platformRole?: 'platform_admin') {
    const { email, password } = account(key);
    let user = await users.findByEmail(email);
    if (user) await users.setPassword(user.id, password);
    else
      user = await users.create({
        email,
        name,
        password,
        ...(platformRole ? { platformRole } : {}),
      });
    return user;
  }
  async function ensureShop(name: string, slug: string, status: 'active' | 'pending_approval') {
    const existing = await container.shops.findBySlug(slug);
    if (existing) return existing;
    const shop = await container.shops.createShop({ name, slug, status });
    await container.pricing.setRates(shop.id, DEFAULT_RATES);
    return shop;
  }

  const admin = await ensureUser('ADMIN', 'Dev Admin', 'platform_admin');
  const owner = await ensureUser('OWNER', 'Dev Owner');
  const staff = await ensureUser('STAFF', 'Dev Staff');
  const pendingOwner = await ensureUser('PENDING_OWNER', 'Dev Pending Owner');

  const shop = await ensureShop('Dev Prints', 'dev-prints', 'active');
  await container.shops.addMember({ shopId: shop.id, userId: owner.id, role: 'owner' });
  await container.shops.addMember({ shopId: shop.id, userId: staff.id, role: 'staff' });
  const pending = await ensureShop('Dev Pending Shop', 'dev-pending', 'pending_approval');
  await container.shops.addMember({ shopId: pending.id, userId: pendingOwner.id, role: 'owner' });

  console.log('Dummy accounts are ready (passwords are in apps/api/.env.dev-accounts):');
  console.log(`  platform admin   ${admin.email}   -> /admin`);
  console.log(
    `  shop owner       ${owner.email}   -> /owner   (shop "Dev Prints", students use /s/dev-prints)`,
  );
  console.log(`  shop staff       ${staff.email}   -> /owner   (same shop, limited)`);
  console.log(
    `  pending owner    ${pendingOwner.email}   -> /owner   (shop "Dev Pending Shop", waiting for approval)`,
  );
  console.log('  student          no account: open /s/dev-prints');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      slug: { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
      'owner-password': { type: 'string' },
      pending: { type: 'boolean' },
      'no-default-rates': { type: 'boolean' },
    },
  });

  const env = loadApiEnv();
  const db = createDb(env.DATABASE_URL);
  const container = createContainer({ env, logger: createLogger('warn'), db });

  try {
    if (command === 'create-admin') {
      if (!values.email || !values.name) throw new Error(USAGE);
      const password = values.password ?? generatePassword();
      const user = await container.identity.users.create({
        email: values.email,
        name: values.name,
        password,
        platformRole: 'platform_admin',
      });
      console.log(`Created platform admin ${user.email}`);
      if (!values.password) console.log(`Password (shown once): ${password}`);
    } else if (command === 'set-default-rates') {
      if (!values.slug) throw new Error(USAGE);
      const shop = await container.shops.findBySlug(values.slug);
      if (!shop) throw new Error(`No shop with slug "${values.slug}"`);
      await container.pricing.setRates(shop.id, DEFAULT_RATES);
      console.log(`Applied the starter rate card to "${shop.name}"`);
    } else if (command === 'create-shop') {
      const ownerEmail = values['owner-email'];
      const ownerName = values['owner-name'];
      if (!values.name || !values.slug || !ownerEmail || !ownerName) throw new Error(USAGE);

      let owner = await container.identity.users.findByEmail(ownerEmail);
      let generated: string | undefined;
      if (!owner) {
        generated = values['owner-password'] ? undefined : generatePassword();
        owner = await container.identity.users.create({
          email: ownerEmail,
          name: ownerName,
          password: values['owner-password'] ?? generated!,
        });
      }
      const shop = await container.shops.createShop({
        name: values.name,
        slug: values.slug,
        status: values.pending ? 'pending_approval' : 'active',
      });
      await container.shops.addMember({ shopId: shop.id, userId: owner.id, role: 'owner' });
      if (!values['no-default-rates']) await container.pricing.setRates(shop.id, DEFAULT_RATES);

      console.log(`Created shop "${shop.name}" (/${shop.slug}), id ${shop.id}`);
      console.log(`Owner: ${owner.email}${generated ? ` (new account)` : ' (existing account)'}`);
      if (generated) console.log(`Password (shown once): ${generated}`);
    } else if (command === 'seed-dev-accounts') {
      await seedDevAccounts(env.NODE_ENV, env.DATABASE_URL, container);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
