import type { ApiEnv } from '@print/config';
import type { Db } from '../../platform/db/client.js';
import type { Audit } from '../audit/index.js';
import { authenticate, requireAuth, requirePlatformAdmin } from './http/middleware.js';
import { createAuthRouter } from './http/routes.js';
import { createIdentityRepo } from './repo/identity-repo.js';
import { createAuthService } from './service/auth-service.js';
import { createSessionService } from './service/session-service.js';

export { requireAuth, requirePlatformAdmin };

/** Public API of the identity module: users, passwords, sessions, and auth middleware. */
export function createIdentity(deps: { db: Db; env: ApiEnv; audit: Audit }) {
  const repo = createIdentityRepo(deps.db);
  const sessions = createSessionService(repo, {
    secret: deps.env.SESSION_SECRET,
    ttlHours: deps.env.SESSION_TTL_HOURS,
  });
  const auth = createAuthService({ repo, sessions, audit: deps.audit });

  return {
    router: createAuthRouter({
      auth,
      secureCookies: deps.env.NODE_ENV === 'production',
      loginRateLimitMax: deps.env.LOGIN_RATE_LIMIT_MAX,
    }),
    authenticate: authenticate(sessions),
    users: {
      create: auth.createUser,
      findByEmail: auth.findUserByEmail,
    },
    sessions: { purgeExpired: sessions.purgeExpired },
    revokeAllSessions: auth.revokeAllSessions,
  };
}

export type Identity = ReturnType<typeof createIdentity>;
