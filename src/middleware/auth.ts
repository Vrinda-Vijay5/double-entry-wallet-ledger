import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { type Role, verifyAccessToken } from '../modules/auth/tokens';

export interface AuthenticatedUser {
  id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/** Rejects the request unless it carries a valid, unexpired access token. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    next(new UnauthorizedError('missing bearer token'));
    return;
  }
  try {
    const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
    req.user = { id: claims.sub, role: claims.role };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * RBAC. Must run after requireAuth.
 *
 * Note this guards *routes*, which is coarse. Ownership of a specific wallet is
 * a separate, finer check enforced in the service layer against the database --
 * a role alone never authorises access to a particular row.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError(`requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
