import 'dotenv/config';

/**
 * Centralised test environment. Imported by globalSetup and by every
 * integration test file so they agree on which database they are talking to.
 *
 * THIS IS AUTHORITATIVE, NOT A SET OF DEFAULTS. An earlier version used `??=`
 * and so inherited whatever happened to be in the developer's .env -- which set
 * AUTH_RATE_LIMIT_MAX=20 and made the auth suite fail with 429s on a machine
 * with a .env but pass in CI without one. Tests must not depend on local
 * configuration, so everything except the database URL is forced here.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://ledger:ledger@localhost:5432/ledger_test';

export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';

  // The application under test reads DATABASE_URL. Pointing it at the test
  // database here, rather than in each test file, removes any chance of the
  // suite truncating the development database.
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  // Escape hatch for debugging a single run: TEST_LOG_LEVEL=debug npm test
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';

  process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef0123456789';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012345678';
  process.env.ACCESS_TOKEN_TTL = '15m';
  process.env.REFRESH_TOKEN_TTL_DAYS = '7';

  // Auth rate limiting is exercised by its own dedicated test, which builds a
  // limiter with explicit limits. Everywhere else it is effectively disabled:
  // the suite performs far more logins and refreshes than a human would.
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = '900000';
  process.env.AUTH_RATE_LIMIT_MAX = '1000000';
}

/**
 * Splits TEST_DATABASE_URL into a connection to the `postgres` maintenance
 * database plus the target database name. CREATE/DROP DATABASE cannot run while
 * connected to the database being dropped, so the setup connects elsewhere.
 */
export function splitMaintenance(): { adminUrl: string; database: string } {
  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.replace(/^\//, '');
  url.pathname = '/postgres';
  return { adminUrl: url.toString(), database };
}
