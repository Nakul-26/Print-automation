import { HttpError } from '../../../platform/http/error-handler.js';
import type { PlatformRole } from '../../../platform/db/enums.js';
import type { Audit } from '../../audit/index.js';
import type { IdentityRepo, UserRecord } from '../repo/identity-repo.js';
import {
  burnPasswordCheck,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from './password.js';
import type { SessionService } from './session-service.js';

export interface RequestMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export function createAuthService(deps: {
  repo: IdentityRepo;
  sessions: SessionService;
  audit: Audit;
  /** Called after a user's session ends, so live connections can be closed. */
  onSessionEnded?: (userId: string) => void;
}) {
  const { repo, sessions, audit } = deps;

  return {
    async createUser(input: {
      email: string;
      name: string;
      password: string;
      platformRole?: PlatformRole;
    }): Promise<UserRecord> {
      const email = input.email.trim().toLowerCase();
      if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new HttpError(
          400,
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          'weak_password',
        );
      }
      if (await repo.findUserByEmail(email)) {
        throw new HttpError(409, 'A user with this email already exists', 'email_taken');
      }
      return repo.createUser({
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        platformRole: input.platformRole ?? 'user',
      });
    },

    findUserByEmail(email: string): Promise<UserRecord | null> {
      return repo.findUserByEmail(email.trim().toLowerCase());
    },

    async login(
      email: string,
      password: string,
      meta: RequestMeta,
    ): Promise<{ user: UserRecord; token: string; expiresAt: Date }> {
      const user = await repo.findUserByEmail(email);
      const valid = user
        ? await verifyPassword(user.passwordHash, password)
        : (await burnPasswordCheck(password), false);

      if (!user || !valid || !user.isActive) {
        await audit.record({
          actorType: 'anonymous',
          action: 'auth.login_failed',
          metadata: { email, ip: meta.ip },
        });
        // Same message for unknown email, wrong password, and disabled account.
        throw new HttpError(401, 'Incorrect email or password', 'invalid_credentials');
      }

      const session = await sessions.create({ userId: user.id, ...meta });
      await audit.record({
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login',
        metadata: { ip: meta.ip },
      });
      return { user, ...session };
    },

    async logout(token: string, userId: string): Promise<void> {
      await sessions.revoke(token);
      deps.onSessionEnded?.(userId);
      await audit.record({ actorType: 'user', actorId: userId, action: 'auth.logout' });
    },

    /** Used when a password changes or an account is disabled. */
    async revokeAllSessions(userId: string): Promise<void> {
      await sessions.revokeAllForUser(userId);
      deps.onSessionEnded?.(userId);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
