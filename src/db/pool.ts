import { Pool, types } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { logger } from '../logger';

/**
 * NOTE ON BIGINT: node-postgres returns int8 as a *string* by default, and we
 * deliberately keep it that way. Coercing int8 to a JS number would silently
 * lose precision above 2^53, which in a ledger means losing money. Every amount
 * crosses the driver boundary as a string and is parsed to `bigint` in the
 * domain layer. Do not install a parser for OID 20.
 */
const INT8_OID = 20;
types.setTypeParser(INT8_OID, (value: string) => value);

let pool: Pool | null = null;

export function createPool(connectionString: string, overrides: PoolConfig = {}): Pool {
  const p = new Pool({
    connectionString,
    // The concurrency suite fires hundreds of parallel requests; a small pool
    // would serialise them at the driver and hide real lock contention.
    max: Number(process.env.PG_POOL_MAX ?? 30),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...overrides,
  });

  p.on('error', (err) => {
    // Idle client blew up (server restart, network). Log, don't crash.
    logger.error({ err }, 'unexpected postgres client error');
  });

  return p;
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = createPool(url);
  }
  return pool;
}

export function setPool(p: Pool): void {
  pool = p;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type { PoolClient };
