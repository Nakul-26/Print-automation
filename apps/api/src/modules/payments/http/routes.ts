import { Router, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  ConfirmPaymentBody,
  ORDER_LOOKUP_TOKEN_PATTERN,
  SavePaymentKeysBody,
  SetPaymentEnabledBody,
  type PaymentSettingsView,
  type PaymentStatusResponse,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { PaymentService } from '../service/payment-service.js';

function limiter(max: number) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many requests, please wait a moment', 'rate_limited')),
  });
}

/**
 * The student's side of paying online, mounted under /api/v1. The order token is the only
 * credential, exactly as for viewing the order.
 */
export function createStudentPaymentsRouter(deps: {
  payments: PaymentService;
  rateLimitMax: number;
}): Router {
  const router = Router();
  const slow = limiter(deps.rateLimitMax);

  const tokenOf = (value: unknown): string => {
    if (typeof value !== 'string' || !ORDER_LOOKUP_TOKEN_PATTERN.test(value)) {
      throw new HttpError(404, 'Order not found', 'not_found');
    }
    return value;
  };
  const send = (res: Response, body: PaymentStatusResponse) => {
    res.set('Cache-Control', 'no-store');
    res.json(body);
  };

  router.get('/orders/:token/payment', async (req, res) => {
    send(res, await deps.payments.status(tokenOf(req.params['token'])));
  });

  /** The payment window reports success; only the gateway's signature is believed. */
  router.post('/orders/:token/payment/confirm', slow, async (req, res) => {
    const body = ConfirmPaymentBody.parse(req.body);
    send(res, await deps.payments.confirm(tokenOf(req.params['token']), body));
  });

  /** Asks the gateway now, for a student who closed the window or came back later. */
  router.post('/orders/:token/payment/refresh', slow, async (req, res) => {
    send(res, await deps.payments.refresh(tokenOf(req.params['token'])));
  });

  router.post('/orders/:token/payment/counter', slow, async (req, res) => {
    send(res, await deps.payments.switchToCounter(tokenOf(req.params['token'])));
  });

  return router;
}

/** The owner's payment settings, mounted at /api/v1/owner/shops. Owner only: staff never see keys. */
export function createOwnerPaymentsRouter(deps: {
  payments: PaymentService;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth);

  const ownerOnly: RequestHandler = (req, _res, next) => {
    if (req.tenant?.role !== 'owner') {
      return next(new HttpError(403, 'Only the shop owner can manage payments', 'forbidden'));
    }
    next();
  };
  const guard = [deps.requireShopAccess, ownerOnly];
  const reply = (res: Response, body: PaymentSettingsView) => {
    res.set('Cache-Control', 'no-store');
    res.json(body);
  };

  router.get('/:shopId/payments', ...guard, async (req, res) => {
    reply(res, await deps.payments.settingsView(req.tenant!.shopId));
  });

  router.put('/:shopId/payments/keys', ...guard, async (req, res) => {
    const body = SavePaymentKeysBody.parse(req.body);
    reply(res, await deps.payments.saveKeys(req.tenant!.shopId, req.tenant!.userId, body));
  });

  router.post('/:shopId/payments/enabled', ...guard, async (req, res) => {
    const body = SetPaymentEnabledBody.parse(req.body);
    reply(
      res,
      await deps.payments.setEnabled(req.tenant!.shopId, req.tenant!.userId, body.enabled),
    );
  });

  router.delete('/:shopId/payments/keys', ...guard, async (req, res) => {
    reply(res, await deps.payments.removeKeys(req.tenant!.shopId, req.tenant!.userId));
  });

  return router;
}
