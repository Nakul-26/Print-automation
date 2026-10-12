import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { PrinterMappingBody } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { PrintingService } from '../service/printing-service.js';

/** The owner's printing setup, mounted at /api/v1/owner/shops. Changes need the owner role. */
export function createOwnerPrintingRouter(deps: {
  printing: PrintingService;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth);

  const ownerOnly: RequestHandler = (req, _res, next) => {
    if (req.tenant?.role !== 'owner') {
      throw new HttpError(403, 'Only the shop owner can change printing settings', 'forbidden');
    }
    next();
  };

  router.get('/:shopId/printing', deps.requireShopAccess, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await deps.printing.status(req.tenant!.shopId));
  });

  router.post('/:shopId/printing/pairing', deps.requireShopAccess, ownerOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await deps.printing.createPairingCode(req.tenant!));
  });

  router.put('/:shopId/printing/mapping', deps.requireShopAccess, ownerOnly, async (req, res) => {
    const body = PrinterMappingBody.parse(req.body);
    res.json(await deps.printing.setMapping(req.tenant!, body));
  });

  router.post('/:shopId/printing/test', deps.requireShopAccess, ownerOnly, async (req, res) => {
    res.status(202).json(await deps.printing.sendTestPages(req.tenant!));
  });

  router.delete(
    '/:shopId/printing/agents/:deviceId',
    deps.requireShopAccess,
    ownerOnly,
    async (req, res) => {
      const deviceId = z.uuid().safeParse(req.params['deviceId']);
      if (!deviceId.success) throw new HttpError(404, 'Printing app not found', 'not_found');
      await deps.printing.removeAgent(req.tenant!, deviceId.data);
      res.status(204).end();
    },
  );

  return router;
}
