import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../logger';

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Arbitrary but fixed key so concurrent migrators serialise instead of racing. */
const MIGRATION_ADVISORY_LOCK = 8_273_461_099n;

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    // Zero-padded numeric prefixes make lexicographic order the correct order.
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/**
 * Applies pending migrations.
 *
 * Each migration runs inside its own transaction, so a failure leaves the
 * database at the last good version rather than half-migrated. An advisory lock
 * around the whole run means two instances booting simultaneously (a rolling
 * deploy, or several Jest workers) cannot both apply the same file.
 */
export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK.toString()]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const migration of loadMigrations(dir)) {
      const existing = seen.get(migration.name);

      if (existing !== undefined) {
        // Editing an already-applied migration means the schema on disk and the
        // schema in the database have silently diverged. Refuse to continue.
        if (existing !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was modified after being applied ` +
              `(expected checksum ${existing}, found ${migration.checksum}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.name);
        logger.info({ migration: migration.name }, 'applied migration');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `migration ${migration.name} failed: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    return applied;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK.toString()])
      .catch(() => undefined);
    client.release();
  }
}
