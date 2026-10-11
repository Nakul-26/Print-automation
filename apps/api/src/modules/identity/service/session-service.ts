import { createHmac, randomBytes } from 'node:crypto';
import type { IdentityRepo, SessionWithUser } from '../repo/identity-repo.js';

const REFRESH_AFTER_MS = 60 * 60 * 1000; // slide the expiry at most once an hour

export function createSessionService(
  repo: IdentityRepo,
  opts: { secret: string; ttlHours: number; now?: () => Date },
) {
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlHours * 60 * 60 * 1000;

  // Only an HMAC of the token is stored, so a database leak cannot be replayed as cookies.
  const hashToken = (token: string): string =>
    createHmac('sha256', opts.secret).update(token).digest('hex');

  return {
    async create(input: {
      userId: string;
      userAgent?: string | undefined;
      ip?: string | undefined;
    }): Promise<{ token: string; expiresAt: Date }> {
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now().getTime() + ttlMs);
      await repo.createSession({ ...input, tokenHash: hashToken(token), expiresAt });
      return { token, expiresAt };
    },

    /** Returns the session if the token is valid, unexpired, and the user is still active. */
    async resolve(token: string): Promise<SessionWithUser | null> {
      const session = await repo.findSessionByTokenHash(hashToken(token));
      if (!session) return null;

      const current = now();
      if (session.expiresAt <= current) {
        await repo.deleteSessionByTokenHash(hashToken(token));
        return null;
      }
      if (!session.user.isActive) return null;

      if (current.getTime() - session.lastUsedAt.getTime() > REFRESH_AFTER_MS) {
        await repo.touchSession(session.id, new Date(current.getTime() + ttlMs));
      }
      return session;
    },

    revoke(token: string): Promise<void> {
      return repo.deleteSessionByTokenHash(hashToken(token));
    },

    revokeAllForUser(userId: string): Promise<void> {
      return repo.deleteSessionsForUser(userId);
    },

    purgeExpired(): Promise<number> {
      return repo.deleteExpiredSessions(now());
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
