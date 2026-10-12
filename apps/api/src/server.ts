import { createServer } from 'node:http';
import express from 'express';
import { loadApiEnv } from '@print/config';
import { createApp } from './app.js';
import { createContainer } from './composition.js';
import { createHealthRouter } from './modules/health/index.js';
import { createDb } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';

const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const db = createDb(env.DATABASE_URL);
  const container = createContainer({ env, logger, db });
  const { capacity } = container;
  logger.info({ role: env.APP_ROLE, capacity }, 'starting');

  const readinessChecks = [
    { name: 'database', run: () => db.$queryRaw`SELECT 1` },
    { name: 'ghostscript', run: () => container.conversion.checkTools() },
  ];

  // A worker serves no browsers: it only needs a health endpoint for the container probe.
  const serveWeb = env.APP_ROLE !== 'worker';
  const app = serveWeb
    ? createApp({ env, logger, container, readinessChecks })
    : express().use(createHealthRouter(readinessChecks));
  const server = createServer(app);
  if (serveWeb) container.realtime.attach(server);
  else container.realtime.attachEmitterOnly();

  await container.start();
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, `${env.APP_ROLE} listening`));

  const purgeTimer = setInterval(() => {
    container.identity.sessions
      .purgeExpired()
      .catch((err) => logger.error({ err }, 'failed to purge expired sessions'));
  }, SESSION_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    clearInterval(purgeTimer);
    server.close(() => {
      void container
        .stop()
        .then(() => db.$disconnect())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
