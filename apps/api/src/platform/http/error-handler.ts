import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../observability/logger.js';

/** Errors that are safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
  }
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by its 4-argument signature.
  return (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
      });
      return;
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  };
}
