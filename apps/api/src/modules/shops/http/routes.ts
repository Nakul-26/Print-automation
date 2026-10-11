import { Router, type RequestHandler } from 'express';
import type { ShopDetail, ShopListResponse } from '@print/contracts';
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

  return router;
}
