import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  CreateOrderRequest,
  EstimateRequest,
  ORDER_LOOKUP_TOKEN_PATTERN,
  OrderItemInput,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { OrderService } from '../service/order-service.js';

function limiter(max: number, message: string) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, message, 'rate_limited')),
  });
}

/** Public routes the student uses to browse a shop, price a job, and place an order. */
export function createOrdersRouter(deps: {
  orders: OrderService;
  orderRateLimitMax: number;
  estimateRateLimitMax: number;
}): Router {
  const router = Router();
  const slugOf = (req: Request): string => String(req.params['slug']);

  router.get('/shops/:slug', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await deps.orders.getPublicInfo(slugOf(req)));
  });

  router.post(
    '/shops/:slug/estimate',
    limiter(deps.estimateRateLimitMax, 'Too many requests, please wait a moment'),
    async (req, res) => {
      const body = EstimateRequest.parse(req.body);
      res.set('Cache-Control', 'no-store');
      res.json(await deps.orders.estimate(slugOf(req), body));
    },
  );

  router.post(
    '/shops/:slug/print-preview',
    limiter(deps.estimateRateLimitMax, 'Too many requests, please wait a moment'),
    async (req, res) => {
      const body = OrderItemInput.parse(req.body);
      const pdf = await deps.orders.previewPrint(slugOf(req), body);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="print-preview.pdf"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(pdf);
    },
  );

  router.post(
    '/shops/:slug/orders',
    limiter(
      deps.orderRateLimitMax,
      'Too many orders from this connection, please wait a few minutes',
    ),
    async (req, res) => {
      const body = CreateOrderRequest.parse(req.body);
      const created = await deps.orders.create(slugOf(req), body, { ip: req.ip });
      res.status(201).json(created);
    },
  );

  router.get('/orders/:token', async (req, res) => {
    const token = req.params['token'];
    if (typeof token !== 'string' || !ORDER_LOOKUP_TOKEN_PATTERN.test(token)) {
      throw new HttpError(404, 'Order not found', 'not_found');
    }
    res.set('Cache-Control', 'no-store');
    res.json(await deps.orders.getByToken(token));
  });

  return router;
}
