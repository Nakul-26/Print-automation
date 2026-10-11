import type { RequestHandler } from 'express';
import type { Db } from '../../platform/db/client.js';
import type { Audit } from '../audit/index.js';
import { requireShopAccess } from './http/tenant.js';
import { createOwnerShopsRouter } from './http/routes.js';
import { createShopRepo } from './repo/shop-repo.js';
import { createShopService } from './service/shop-service.js';

/** Public API of the shops module: shops, membership, and tenant access control. */
export function createShops(deps: { db: Db; audit: Audit; requireAuth: RequestHandler }) {
  const repo = createShopRepo(deps.db);
  const service = createShopService({ repo, audit: deps.audit });
  const shopAccess = requireShopAccess(repo);

  return {
    ownerRouter: createOwnerShopsRouter({
      service,
      repo,
      requireAuth: deps.requireAuth,
      requireShopAccess: shopAccess,
    }),
    /** Middleware for any route under /…/:shopId/…; sets req.tenant. Run after requireAuth. */
    requireShopAccess: shopAccess,
    createShop: service.createShop,
    addMember: service.addMember,
  };
}

export type Shops = ReturnType<typeof createShops>;
