import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { ApiEnv } from '@print/config';
import type { Container } from './composition.js';
import { createHealthRouter, type ReadinessCheck } from './modules/health/index.js';
import { createErrorHandler, HttpError, notFoundHandler } from './platform/http/error-handler.js';
import { originCheck } from './platform/http/origin-check.js';
import type { Logger } from './platform/observability/logger.js';

export interface AppDeps {
  env: ApiEnv;
  logger: Logger;
  readinessChecks: ReadinessCheck[];
  container: Container;
}

/** Builds the Express app. No I/O happens here, so tests can create it freely. */
export function createApp({ env, logger, readinessChecks, container }: AppDeps): Express {
  const app = express();
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.APP_ORIGIN, credentials: true }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      // Keep access logs small: method, url, status. No headers.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(originCheck(env.APP_ORIGIN));

  // Probes live at the root so the proxy and Docker healthchecks stay simple.
  app.use(createHealthRouter(readinessChecks));

  // Feature modules mount under /api/v1.
  const v1 = express.Router();
  // A ceiling per connection across the whole API, on top of the stricter per-endpoint limits.
  v1.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: env.API_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(new HttpError(429, 'Too many requests, please slow down', 'rate_limited')),
    }),
  );
  v1.use(container.identity.authenticate);
  v1.use('/auth', container.identity.router);
  v1.use('/applications', container.admin.applyRouter);
  v1.use('/admin', container.admin.adminRouter);
  v1.use('/owner/shops', container.shops.ownerRouter);
  v1.use('/owner/shops', container.pricing.ownerRouter);
  v1.use('/owner/shops', container.orders.ownerRouter);
  v1.use('/owner/shops', container.printing.ownerRouter);
  v1.use('/agent', container.printing.agentRouter);
  v1.use(container.documents.router);
  v1.use(container.orders.router);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
