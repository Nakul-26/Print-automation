import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from '@print/config';
import { createApp } from './app.js';
import { createContainer } from './composition.js';
import type { ReadinessCheck } from './modules/health/index.js';
import { createDb } from './platform/db/client.js';
import { createLogger } from './platform/observability/logger.js';

const env = loadApiEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
  NODE_ENV: 'test',
});
const logger = createLogger('silent' as never);

// The database client connects lazily, so these probe tests never open a connection.
function buildApp(readinessChecks: ReadinessCheck[]) {
  const container = createContainer({ env, logger, db: createDb(env.DATABASE_URL) });
  return createApp({ env, logger, readinessChecks, container });
}

describe('api app', () => {
  it('GET /health is ok without touching dependencies', async () => {
    const res = await request(buildApp([])).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /ready reports degraded (503) when a dependency fails', async () => {
    const app = buildApp([{ name: 'database', run: () => Promise.reject(new Error('down')) }]);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', checks: { database: 'fail' } });
  });

  it('GET /ready is 200 when dependencies are healthy', async () => {
    const app = buildApp([{ name: 'database', run: () => Promise.resolve() }]);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
  });

  it('unknown routes return a JSON 404', async () => {
    const res = await request(buildApp([])).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
