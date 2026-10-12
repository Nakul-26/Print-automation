import type { ApiEnv } from '@print/config';
import type { Db } from '../../platform/db/client.js';
import type { Audit } from '../audit/index.js';
import {
  authenticate,
  requireAuth,
  requirePlatformAdmin,
  SESSION_COOKIE,
} from './http/middleware.js';
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
    /** For non-Express callers such as the realtime gateway: the user id behind a Cookie header. */
    async userIdFromCookieHeader(header: string | undefined): Promise<string | null> {
      const match = header?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
      if (!match?.[1]) return null;
      let token: string;
      try {
        token = decodeURIComponent(match[1]);
      } catch {
        return null;
      }
      const session = await sessions.resolve(token);
      return session?.user.id ?? null;
    },
    users: {
      create: auth.createUser,
      findByEmail: auth.findUserByEmail,
    },
    sessions: { purgeExpired: sessions.purgeExpired },
    revokeAllSessions: auth.revokeAllSessions,
  };
}

export type Identity = ReturnType<typeof createIdentity>;
