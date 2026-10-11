import type { RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { ShopRepo } from '../repo/shop-repo.js';

const ShopIdParam = z.uuid();

/**
 * Authorises the request against the shop named by `:shopId` and sets `req.tenant`.
 *
 * Isolation rules:
 * - the caller must be a member of that shop (a platform admin is NOT implicitly a member;
 *   admins use /admin routes), checked against the database on every request;
 * - a non-member gets 404, identical to a shop that does not exist, so IDs cannot be probed;
 * - a suspended shop is refused for its own members.
 *
 * Must run after `requireAuth`.
 */
export function requireShopAccess(repo: ShopRepo): RequestHandler {
  return async (req, _res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new HttpError(401, 'Sign in required', 'unauthenticated');

      const shopId = ShopIdParam.safeParse(req.params['shopId']);
      const notFound = new HttpError(404, 'Shop not found', 'not_found');
      if (!shopId.success) throw notFound;

      const membership = await repo.findMembership(shopId.data, auth.userId);
      if (!membership) throw notFound;
      if (membership.shop.status === 'suspended') {
        throw new HttpError(403, 'This shop is suspended', 'shop_suspended');
      }

      req.tenant = { shopId: shopId.data, userId: auth.userId, role: membership.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}
