import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadApiEnv } from '@print/config';
import { createContainer } from './composition.js';
import { createDb } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';

const USAGE = `Usage:
  pnpm --filter @print/api cli create-admin --email <email> --name <name> [--password <pw>]
  pnpm --filter @print/api cli create-shop --name <shop name> --slug <slug>
        --owner-email <email> --owner-name <name> [--owner-password <pw>] [--pending]

Passwords are generated and printed once if not supplied. Shops are created active unless --pending.`;

const generatePassword = (): string => randomBytes(12).toString('base64url');

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

      console.log(`Created shop "${shop.name}" (/${shop.slug}), id ${shop.id}`);
      console.log(`Owner: ${owner.email}${generated ? ` (new account)` : ' (existing account)'}`);
      if (generated) console.log(`Password (shown once): ${generated}`);
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
