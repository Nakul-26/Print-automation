import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { OrderActionBody, type OwnerQueueResponse } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { OrderService } from '../service/order-service.js';

const Id = z.uuid();

/** What the shop sees and does, mounted at /api/v1/owner/shops. Every route is scoped to the caller's shop. */
export function createOwnerOrdersRouter(deps: {
  orders: OrderService;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth);

  const idParam = (value: unknown): string => {
    const parsed = Id.safeParse(value);
    if (!parsed.success) throw new HttpError(404, 'Not found', 'not_found');
    return parsed.data;
  };

  router.get('/:shopId/orders', deps.requireShopAccess, async (req, res) => {
    const body: OwnerQueueResponse = { orders: await deps.orders.listQueue(req.tenant!.shopId) };
    res.set('Cache-Control', 'no-store');
    res.json(body);
  });

  router.post('/:shopId/orders/:orderId/actions', deps.requireShopAccess, async (req, res) => {
    const body = OrderActionBody.parse(req.body);
    const order = await deps.orders.act(req.tenant!, idParam(req.params['orderId']), body);
    res.set('Cache-Control', 'no-store');
    res.json(order);
  });

  router.get(
    '/:shopId/orders/:orderId/items/:itemId/file',
    deps.requireShopAccess,
    async (req, res, next) => {
      const file = await deps.orders.openPrintFile(
        req.tenant!.shopId,
        idParam(req.params['orderId']),
        idParam(req.params['itemId']),
      );
      const disposition = req.query['download'] === '1' ? 'attachment' : 'inline';
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="${file.fileName}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(file.bytes ? { 'Content-Length': String(file.bytes) } : {}),
      });
      file.stream.on('error', next);
      file.stream.pipe(res);
    },
  );

  return router;
}
