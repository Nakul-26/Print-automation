import { Router, type CookieOptions } from 'express';
import { rateLimit } from 'express-rate-limit';
import { LoginRequest, type MeResponse } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { AuthService } from '../service/auth-service.js';
import { requireAuth, SESSION_COOKIE } from './middleware.js';

export function createAuthRouter(deps: {
  auth: AuthService;
  secureCookies: boolean;
  loginRateLimitMax: number;
}): Router {
  const router = Router();

  const cookieOptions = (expires?: Date): CookieOptions => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.secureCookies,
    path: '/',
    ...(expires ? { expires } : {}),
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.loginRateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many attempts, try again later', 'rate_limited')),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const body = LoginRequest.parse(req.body);
    const { user, token, expiresAt } = await deps.auth.login(body.email, body.password, {
      userAgent: req.get('user-agent'),
      ip: req.ip,
    });
    res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
    const response: MeResponse = {
      user: { id: user.id, email: user.email, name: user.name, platformRole: user.platformRole },
    };
    res.json(response);
  });

  router.post('/logout', requireAuth, async (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') await deps.auth.logout(token, req.auth!.userId);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    const a = req.auth!;
    const response: MeResponse = {
      user: { id: a.userId, email: a.email, name: a.name, platformRole: a.platformRole },
    };
    res.json(response);
  });

  return router;
}
