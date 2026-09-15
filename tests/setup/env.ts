import 'dotenv/config';

/**
 * Centralised test environment. Imported by globalSetup and by every
 * integration test file so they agree on which database they are talking to.
 *
 * The suite points DATABASE_URL at TEST_DATABASE_URL, because the application
 * code under test reads DATABASE_URL. Doing it here rather than in each test
 * removes any chance of a test file accidentally running against the dev
 * database -- which, given the suite truncates tables, would be destructive.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://ledger:ledger@localhost:5432/ledger_test';

export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL ??= 'silent';
  process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef0123456789';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef012345678';
  process.env.ACCESS_TOKEN_TTL ??= '15m';
  process.env.REFRESH_TOKEN_TTL_DAYS ??= '7';
  // Auth rate limiting would otherwise reject the many logins the suite performs.
  process.env.AUTH_RATE_LIMIT_MAX ??= '100000';
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
