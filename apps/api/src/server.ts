import { createServer } from 'node:http';
import { loadApiEnv } from '@print/config';
import { createApp } from './app.js';
import { createDb } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL);

  const app = createApp({
    env,
    logger,
    readinessChecks: [{ name: 'database', run: () => db.$queryRaw`SELECT 1` }],
  });
  const server = createServer(app);

  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void db.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
