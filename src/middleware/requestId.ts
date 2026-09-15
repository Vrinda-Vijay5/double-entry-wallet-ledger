import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Attaches a request id, preferring an inbound X-Request-Id so a trace can be
 * followed across service hops. Echoed on the response and included in every
 * error body, which is what makes a user-reported failure findable in the logs.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  // Bound the length: an unbounded header value would be echoed into logs.
  const id =
    inbound && inbound.length > 0 && inbound.length <= 200 ? inbound : randomUUID();
  res.setHeader('x-request-id', id);
  (req as { id?: string }).id = id;
  next();
};
