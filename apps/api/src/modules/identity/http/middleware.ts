import type { RequestHandler } from 'express';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { SessionService } from '../service/session-service.js';

export const SESSION_COOKIE = 'pp_session';

/** Populates req.auth when a valid session cookie is present. Never rejects. */
export function authenticate(sessions: SessionService): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token === 'string' && token.length > 0) {
        const session = await sessions.resolve(token);
        if (session) {
          req.auth = {
            userId: session.user.id,
            email: session.user.email,
            name: session.user.name,
            platformRole: session.user.platformRole,
            sessionId: session.id,
          };
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new HttpError(401, 'Sign in required', 'unauthenticated'));
    return;
  }
  next();
};

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new HttpError(401, 'Sign in required', 'unauthenticated'));
  } else if (req.auth.platformRole !== 'platform_admin') {
    next(new HttpError(403, 'Not allowed', 'forbidden'));
  } else {
    next();
  }
};
