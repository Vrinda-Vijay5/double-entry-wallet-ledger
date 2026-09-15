import { Client, Pool } from 'pg';
import { applyTestEnv, TEST_DATABASE_URL, splitMaintenance } from './env';
import { migrate } from '../../src/db/migrate';

/**
 * Creates a pristine test database and migrates it, once, before the
 * integration suite runs.
 *
 * Recreating rather than truncating guarantees the schema under test is exactly
 * what the migrations produce -- including the triggers the correctness proofs
 * depend on. A stale hand-patched test database is a classic source of "passes
 * locally, fails in CI".
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();

  const { adminUrl, database } = splitMaintenance();
  const admin = new Client({ connectionString: adminUrl });

  await admin.connect().catch((err) => {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.replace(/:[^:@/]*@/, ':***@')}.\n` +
        'Start it with:  docker compose up -d\n' +
        `Underlying error: ${(err as Error).message}`,
    );
  });

  try {
    // Evict anything still holding the database open from a previous aborted run.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

/** Minimal identifier quoting; database names here come from our own env file. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to use unsafe database name: ${name}`);
  }
  return `"${name}"`;
}
