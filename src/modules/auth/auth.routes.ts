import { Router } from 'express';
import { config } from '../../config';
import { UnauthorizedError } from '../../errors';
import { withTransaction } from '../../db/tx';
import { requireAuth } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/error';
import { createAuthRateLimiter } from '../../middleware/rateLimit';
import { idempotencyKeyOf, requireIdempotencyKey } from '../../middleware/idempotency';
import { runIdempotent } from '../idempotency/idempotency';
import { LoginSchema, RefreshSchema, RegisterSchema } from './auth.schemas';
import {
  burnVerifyForTiming,
  findUserByEmail,
  issueTokenPair,
  registerUser,
  revokeAllTokensForUser,
  rotateRefreshToken,
  verifyPassword,
} from './auth.service';

export function authRoutes(): Router {
  const router = Router();
  const cfg = config();
  const limiter = createAuthRateLimiter({
    windowMs: cfg.AUTH_RATE_LIMIT_WINDOW_MS,
    max: cfg.AUTH_RATE_LIMIT_MAX,
  });

  router.post(
    '/register',
    limiter,
    requireIdempotencyKey,
    asyncHandler(async (req, res) => {
      const input = RegisterSchema.parse(req.body);

      const result = await withTransaction(async (client) => {
        const user = await registerUser(client, input);
        const tokens = await issueTokenPair(client, user);
        return {
          user: { id: user.id, email: user.email, role: user.role },
          ...tokens,
        };
      });

      res.status(201).json(result);
    }),
  );

  router.post(
    '/login',
    limiter,
    asyncHandler(async (req, res) => {
      const input = LoginSchema.parse(req.body);

      const result = await withTransaction(async (client) => {
        const user = await findUserByEmail(client, input.email);

        // Identical error and comparable timing for "no such user" and "wrong
        // password": distinguishing them turns login into an account-enumeration
        // oracle.
        if (!user) {
          await burnVerifyForTiming(input.password);
          throw new UnauthorizedError('invalid email or password');
        }

        const ok = await verifyPassword(user.password_hash, input.password);
        if (!ok) throw new UnauthorizedError('invalid email or password');

        const tokens = await issueTokenPair(client, user);
        return {
          user: { id: user.id, email: user.email, role: user.role },
          ...tokens,
        };
      });

      res.status(200).json(result);
    }),
  );

  /**
   * Refresh is deliberately EXEMPT from the Idempotency-Key requirement.
   *
   * Rotation is non-idempotent by design: every successful call must invalidate
   * the presented token and mint a new one. Replaying a cached response would
   * hand the same refresh token back twice, defeating rotation entirely. The
   * refresh token itself is the single-use key here.
   */
  router.post(
    '/refresh',
    limiter,
    asyncHandler(async (req, res) => {
      const input = RefreshSchema.parse(req.body);
      const tokens = await withTransaction((client) =>
        rotateRefreshToken(client, input.refreshToken),
      );
      res.status(200).json(tokens);
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    requireIdempotencyKey,
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const result = await withTransaction(async (client) => {
        const outcome = await runIdempotent<{ revoked: boolean }>(
          client,
          {
            userId: user.id,
            idempotencyKey: idempotencyKeyOf(req),
            endpoint: 'POST /v1/auth/logout',
            requestBody: {},
          },
          async () => {
            await revokeAllTokensForUser(client, user.id);
            return { status: 200, body: { revoked: true } };
          },
        );
        return outcome;
      });
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json({ id: req.user!.id, role: req.user!.role });
    }),
  );

  return router;
}
