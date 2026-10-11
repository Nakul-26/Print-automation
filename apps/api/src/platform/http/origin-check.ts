import type { RequestHandler } from 'express';
import { HttpError } from './error-handler.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth (cookies are also SameSite=Lax): browsers always send Origin on
 * cross-site state-changing requests, so reject any whose Origin is not our own app.
 * Requests without an Origin (curl, server-to-server, the print agent) are not browser CSRF.
 */
export function originCheck(allowedOrigin: string): RequestHandler {
  const allowed = new URL(allowedOrigin).origin;
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (!SAFE_METHODS.has(req.method) && origin && origin !== allowed) {
      next(new HttpError(403, 'Cross-origin request blocked', 'bad_origin'));
      return;
    }
    next();
  };
}
