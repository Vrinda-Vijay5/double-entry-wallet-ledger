import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requestId } from './middleware/requestId';
import { authRoutes } from './modules/auth/auth.routes';
import { transferRoutes } from './modules/transfers/transfers.routes';
import { walletRoutes } from './modules/wallets/wallets.routes';
import { getPool } from './db/pool';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer this makes req.ip the real client address, which the
  // auth rate limiter keys on. Trust exactly one hop, not a blanket `true`:
  // trusting every proxy lets a client spoof X-Forwarded-For and evade limits.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => (res.getHeader('x-request-id') as string) ?? '',
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  // Bounded body size: the API only ever accepts small JSON documents.
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.use('/v1/auth', authRoutes());
  app.use('/v1/wallets', walletRoutes());
  app.use('/v1/transfers', transferRoutes());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
