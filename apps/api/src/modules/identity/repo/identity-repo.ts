import type { Db } from '../../../platform/db/client.js';
import type { PlatformRole } from '../../../platform/db/enums.js';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  platformRole: PlatformRole;
  isActive: boolean;
}

export interface SessionWithUser {
  id: string;
  userId: string;
  expiresAt: Date;
  lastUsedAt: Date;
  user: UserRecord;
}

/** The only code in this module that touches the database. */
export function createIdentityRepo(db: Db) {
  const userSelect = {
    id: true,
    email: true,
    name: true,
    passwordHash: true,
    platformRole: true,
    isActive: true,
  } as const;

  return {
    findUserByEmail(email: string): Promise<UserRecord | null> {
      return db.user.findUnique({ where: { email }, select: userSelect });
    },

    createUser(data: {
      email: string;
      name: string;
      passwordHash: string;
      platformRole: PlatformRole;
    }): Promise<UserRecord> {
      return db.user.create({ data, select: userSelect });
    },

    async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
      await db.user.update({ where: { id: userId }, data: { passwordHash } });
    },

    async createSession(data: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | undefined;
      ip?: string | undefined;
    }): Promise<void> {
      await db.session.create({ data });
    },

    findSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
      return db.session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          lastUsedAt: true,
          user: { select: userSelect },
        },
      });
    },

    async touchSession(sessionId: string, expiresAt: Date): Promise<void> {
      await db.session.update({
        where: { id: sessionId },
        data: { lastUsedAt: new Date(), expiresAt },
      });
    },

    async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
      await db.session.deleteMany({ where: { tokenHash } });
    },

    async deleteSessionsForUser(userId: string): Promise<void> {
      await db.session.deleteMany({ where: { userId } });
    },

    async deleteExpiredSessions(now: Date): Promise<number> {
      const { count } = await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
      return count;
    },
  };
}

export type IdentityRepo = ReturnType<typeof createIdentityRepo>;
