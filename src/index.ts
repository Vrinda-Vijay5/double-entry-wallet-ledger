import 'dotenv/config';
import { createApp } from './app';
import { config } from './config';
import { closePool, getPool } from './db/pool';
import { logger } from './logger';

async function main(): Promise<void> {
  const cfg = config();

  // Fail fast if the database is unreachable rather than accepting traffic we
  // cannot serve.
  await getPool().query('SELECT 1');

  const server = createApp().listen(cfg.PORT, () => {
    logger.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'ledger api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Stop accepting connections, let in-flight transfers finish, then release
    // the pool. Killing the pool first would abort committed-but-unreturned work.
    server.close(async (err) => {
      if (err) logger.error({ err }, 'error during server close');
      await closePool();
      process.exit(err ? 1 : 0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
