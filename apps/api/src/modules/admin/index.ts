import type { RequestHandler } from 'express';
import type { Settings } from '../../platform/settings/index.js';
import type { Audit } from '../audit/index.js';
import { createAdminRouter, createApplyRouter } from './http/routes.js';
import { createAdminService, type AdminPorts } from './service/admin-service.js';

export type { AdminPorts };

/**
 * Public API of the admin module: shop applications, approval, suspension, per-shop limits and
 * the platform-wide settings. It owns no tables; everything goes through the ports it is given.
 */
export function createAdmin(deps: {
  ports: AdminPorts;
  settings: Settings;
  audit: Audit;
  requireAuth: RequestHandler;
  requirePlatformAdmin: RequestHandler;
  botVerify: (token: string | undefined, ip: string | undefined) => Promise<boolean>;
  applyRateLimitMax: number;
  botSiteKey: string | null;
}) {
  const service = createAdminService({
    ports: deps.ports,
    settings: deps.settings,
    audit: deps.audit,
    botVerify: deps.botVerify,
  });
  return {
    applyRouter: createApplyRouter({
      admin: service,
      rateLimitMax: deps.applyRateLimitMax,
      botSiteKey: deps.botSiteKey,
    }),
    adminRouter: createAdminRouter({
      admin: service,
      requireAuth: deps.requireAuth,
      requirePlatformAdmin: deps.requirePlatformAdmin,
    }),
  };
}

export type Admin = ReturnType<typeof createAdmin>;
