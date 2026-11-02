/**
 * Developer tool: starts the API with a PRETEND payment gateway, so the whole online-payment flow can
 * be tried on your own PC without Razorpay keys or real money. Never used in production (the real
 * server is src/server.ts and always talks to Razorpay).
 *
 *   pnpm --filter @print/api exec tsx --env-file=.env scripts/dev-fake-payments.ts
 *
 * Then in the owner dashboard open Payments and enter the fake keys printed below. The pretend
 * Razorpay window is a small page script (see docs/online-payments.md, "Trying it without keys").
 */
import { createServer } from 'node:http';
import express from 'express';
import { loadApiEnv } from '@print/config';
import { createApp } from '../src/app.js';
import { createContainer } from '../src/composition.js';
import { createDb } from '../src/platform/db/client.js';
import { createLogger } from '../src/platform/observability/logger.js';
import { createFakeGateway, GOOD_KEYS } from '../test/fake-gateway.js';

const env = loadApiEnv();
if (env.NODE_ENV === 'production')
  throw new Error('The pretend payment gateway is for development only.');

const logger = createLogger(env.LOG_LEVEL);
const db = createDb(env.DATABASE_URL);
const fake = createFakeGateway();
const container = createContainer({ env, logger, db, gateway: fake.gateway });
const app = createApp({
  env,
  logger,
  container,
  readinessChecks: [{ name: 'database', run: () => db.$queryRaw`SELECT 1` }],
});

// The pretend payment window asks this endpoint what a successful payment looks like.
const outer = express();
outer.get('/dev/pay/:gatewayOrderId', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const paid = fake.pay(
      String(req.params['gatewayOrderId']),
      String(req.query['method'] ?? 'upi'),
    );
    res.json({
      razorpay_order_id: paid.gatewayOrderId,
      razorpay_payment_id: paid.gatewayPaymentId,
      razorpay_signature: paid.signature,
    });
  } catch {
    res.status(404).json({ error: 'unknown gateway order' });
  }
});
outer.get('/dev/fake-gateway-state', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ refunds: fake.refunds, orders: [...fake.orders.values()] });
});
outer.use(app);

const server = createServer(outer);
container.realtime.attach(server);
await container.start();
server.listen(env.PORT, () => {
  console.log(`API with a PRETEND payment gateway on port ${env.PORT}`);
  console.log(`  Key ID:     ${GOOD_KEYS.keyId}`);
  console.log(`  Key Secret: ${GOOD_KEYS.keySecret}`);
});
