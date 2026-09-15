import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { logger } from '../logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `no route for ${req.method} ${req.path}` },
  });
};

/**
 * Terminal error handler. Two rules:
 *  1. Never leak an internal message or stack to the client.
 *  2. Always log the real error server-side with the request id attached.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.getHeader('x-request-id');

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'request failed validation',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    // Client errors are expected traffic, not incidents -- log at debug.
    logger[err.status >= 500 ? 'error' : 'debug'](
      { err, code: err.code, status: err.status, requestId },
      'request failed',
    );
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      requestId,
    });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'internal server error' },
    requestId,
  });
};

/**
 * Wraps an async handler so a rejected promise reaches Express' error pipeline.
 * Express 4 does not await handlers; without this an async throw becomes an
 * unhandled rejection and the request hangs until the client times out.
 */
export function asyncHandler<T extends RequestHandler>(handler: T): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
