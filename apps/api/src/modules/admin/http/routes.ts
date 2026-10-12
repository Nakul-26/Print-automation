import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  AdminSettingsBody,
  ApplyRequest,
  ShopLimitsBody,
  ShopStatus,
  SuspendBody,
  type ApplyConfig,
  type ApplyResponse,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { AdminService } from '../service/admin-service.js';

const IdParam = z.uuid();

function shopIdOf(value: unknown): string {
  const parsed = IdParam.safeParse(value);
  if (!parsed.success) throw new HttpError(404, 'Shop not found', 'not_found');
  return parsed.data;
}

/** Public sign-up for a new shop, mounted at /api/v1/applications. */
export function createApplyRouter(deps: {
  admin: AdminService;
  rateLimitMax: number;
  botSiteKey: string | null;
}): Router {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many applications, please try again later', 'rate_limited')),
  });

  router.get('/config', (_req, res) => {
    const body: ApplyConfig = { turnstileSiteKey: deps.botSiteKey };
    res.json(body);
  });

  router.post('/', limiter, async (req, res) => {
    const body = ApplyRequest.parse(req.body);
    const response: ApplyResponse = await deps.admin.apply(body, req.ip);
    res.status(201).json(response);
  });
  return router;
}

/** Platform-admin routes, mounted at /api/v1/admin. Every route needs a platform admin. */
export function createAdminRouter(deps: {
  admin: AdminService;
  requireAuth: RequestHandler;
  requirePlatformAdmin: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth, deps.requirePlatformAdmin);

  router.get('/shops', async (req, res) => {
    const status =
      req.query['status'] === undefined ? undefined : ShopStatus.parse(req.query['status']);
    res.json({ shops: await deps.admin.viewShops(status) });
  });

  router.post('/shops/:shopId/approve', async (req, res) => {
    res.json(
      await deps.admin.changeStatus({
        shopId: shopIdOf(req.params['shopId']),
        action: 'approve',
        actorId: req.auth!.userId,
      }),
    );
  });

  router.post('/shops/:shopId/suspend', async (req, res) => {
    const body = SuspendBody.parse(req.body ?? {});
    res.json(
      await deps.admin.changeStatus({
        shopId: shopIdOf(req.params['shopId']),
        action: 'suspend',
        actorId: req.auth!.userId,
        reason: body.reason,
      }),
    );
  });

  router.post('/shops/:shopId/reactivate', async (req, res) => {
    res.json(
      await deps.admin.changeStatus({
        shopId: shopIdOf(req.params['shopId']),
        action: 'reactivate',
        actorId: req.auth!.userId,
      }),
    );
  });

  router.patch('/shops/:shopId', async (req, res) => {
    const body = ShopLimitsBody.parse(req.body);
    res.json(await deps.admin.setLimits(shopIdOf(req.params['shopId']), body, req.auth!.userId));
  });

  router.get('/settings', async (_req, res) => {
    res.json(await deps.admin.getSettings());
  });

  router.put('/settings', async (req, res) => {
    const body = AdminSettingsBody.parse(req.body);
    res.json(await deps.admin.setStorageMax(body.storageMaxBytes, req.auth!.userId));
  });

  router.get('/audit', async (req, res) => {
    const shopId = req.query['shopId'] === undefined ? undefined : shopIdOf(req.query['shopId']);
    const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50) || 50, 1), 200);
    res.json(await deps.admin.recentActivity(shopId, limit));
  });

  return router;
}
