import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PairRequest } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { PrintingService } from '../service/printing-service.js';

/** Routes the shop PC's print agent calls, mounted at /api/v1/agent. */
export function createAgentRouter(deps: {
  printing: PrintingService;
  /** Wrong pairing codes allowed per connection per 15 minutes. */
  pairingFailuresMax: number;
}): Router {
  const router = Router();

  // Only failed attempts count, so a real owner is never blocked by their own successes.
  const pairingLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.pairingFailuresMax,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many wrong codes. Try again in a few minutes.', 'rate_limited')),
  });

  router.post('/pair', pairingLimit, async (req, res) => {
    const body = PairRequest.parse(req.body);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await deps.printing.pair(body));
  });

  const requireAgent: RequestHandler = async (req: Request, _res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const agent = token ? await deps.printing.authenticate(token) : null;
    if (!agent) throw new HttpError(401, 'Unauthorized', 'unauthorized');
    req.agent = agent;
    next();
  };

  router.get('/jobs/:jobId/file', requireAgent, async (req, res, next) => {
    const jobId = String(req.params['jobId']);
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(404, 'File not found', 'not_found');
    const file = await deps.printing.openJobFile(req.agent!, jobId);
    res.set({
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(file.bytes ? { 'Content-Length': String(file.bytes) } : {}),
    });
    file.stream.on('error', next);
    file.stream.pipe(res);
  });

  return router;
}
