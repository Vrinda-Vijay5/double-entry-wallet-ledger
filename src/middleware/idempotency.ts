import type { RequestHandler } from 'express';
import { ValidationError } from '../errors';

/**
 * Requires an Idempotency-Key header on mutating requests.
 *
 * This middleware only enforces PRESENCE and shape. The actual deduplication
 * happens in the service layer (see modules/idempotency), because the claim has
 * to share a transaction with the effect it guards -- middleware runs outside
 * any transaction and could only ever offer advisory, racy protection.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Long enough for a UUID or ULID, bounded so it cannot be used to bloat rows.
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,255}$/;

export const requireIdempotencyKey: RequestHandler = (req, _res, next) => {
  if (!MUTATING.has(req.method)) {
    next();
    return;
  }

  const key = req.header('idempotency-key');
  if (!key) {
    next(
      new ValidationError(
        'Idempotency-Key header is required on mutating requests',
        { header: 'Idempotency-Key' },
      ),
    );
    return;
  }

  if (!KEY_PATTERN.test(key)) {
    next(
      new ValidationError(
        'Idempotency-Key must be 8-255 chars of [A-Za-z0-9_.:-]',
        { header: 'Idempotency-Key' },
      ),
    );
    return;
  }

  next();
};

export function idempotencyKeyOf(req: { header(name: string): string | undefined }): string {
  // Safe: requireIdempotencyKey has already run on every route that calls this.
  return req.header('idempotency-key')!;
}
