import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  AddStaffBody,
  type AddStaffResponse,
  type ResetStaffPasswordResponse,
  type ShopDetail,
  type ShopListResponse,
  type StaffListResponse,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { ShopRepo } from '../repo/shop-repo.js';
import type { ShopService } from '../service/shop-service.js';

/** Owner-facing shop routes, mounted at /api/v1/owner/shops. */
export function createOwnerShopsRouter(deps: {
  service: ShopService;
  repo: ShopRepo;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
}): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/', async (req, res) => {
    const memberships = await deps.service.listForUser(req.auth!.userId);
    const body: ShopListResponse = {
      shops: memberships.map((m) => ({
        id: m.shop.id,
        slug: m.shop.slug,
        name: m.shop.name,
        status: m.shop.status,
        role: m.role,
      })),
    };
    res.json(body);
  });

  router.get('/:shopId', deps.requireShopAccess, async (req, res) => {
    const tenant = req.tenant!;
    const membership = await deps.repo.findMembership(tenant.shopId, tenant.userId);
    if (!membership) throw new HttpError(404, 'Shop not found', 'not_found');
    const { shop } = membership;
    const body: ShopDetail = {
      id: shop.id,
      slug: shop.slug,
      name: shop.name,
      status: shop.status,
      role: membership.role,
      address: shop.address,
      contactPhone: shop.contactPhone,
      timezone: shop.timezone,
      currency: shop.currency,
    };
    res.json(body);
  });

  /** Only the shop's owner manages who can sign in. */
  const ownerOnly: RequestHandler = (req, _res, next) => {
    if (req.tenant?.role !== 'owner') {
      return next(new HttpError(403, 'Only the shop owner can manage staff', 'forbidden'));
    }
    next();
  };
  const userIdParam = (value: unknown): string => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new HttpError(404, 'Person not found', 'not_found');
    return parsed.data;
  };

  router.get('/:shopId/staff', deps.requireShopAccess, ownerOnly, async (req, res) => {
    const body: StaffListResponse = { members: await deps.service.listStaff(req.tenant!.shopId) };
    res.set('Cache-Control', 'no-store');
    res.json(body);
  });

  router.post('/:shopId/staff', deps.requireShopAccess, ownerOnly, async (req, res) => {
    const input = AddStaffBody.parse(req.body);
    const body: AddStaffResponse = await deps.service.addStaff({
      shopId: req.tenant!.shopId,
      actorId: req.tenant!.userId,
      ...input,
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(body);
  });

  router.delete('/:shopId/staff/:userId', deps.requireShopAccess, ownerOnly, async (req, res) => {
    await deps.service.removeStaff({
      shopId: req.tenant!.shopId,
      actorId: req.tenant!.userId,
      userId: userIdParam(req.params['userId']),
    });
    res.status(204).end();
  });

  router.post(
    '/:shopId/staff/:userId/reset-password',
    deps.requireShopAccess,
    ownerOnly,
    async (req, res) => {
      const password = await deps.service.resetStaffPassword({
        shopId: req.tenant!.shopId,
        actorId: req.tenant!.userId,
        userId: userIdParam(req.params['userId']),
      });
      const body: ResetStaffPasswordResponse = { password };
      res.set('Cache-Control', 'no-store');
      res.json(body);
    },
  );

  return router;
}
