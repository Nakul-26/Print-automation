import type { AuthContext, TenantContext } from '../platform/http/context.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      tenant?: TenantContext;
    }
  }
}

export {};
