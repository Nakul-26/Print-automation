import type { AuthContext, TenantContext } from '../platform/http/context.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      tenant?: TenantContext;
      /** The authenticated print agent, on /api/v1/agent routes. */
      agent?: { deviceId: string; shopId: string };
    }
  }
}

export {};
