/**
 * The test database is deliberately LEFT IN PLACE after the run.
 *
 * When a concurrency test fails, the ledger rows it produced are the primary
 * evidence -- dropping them on the way out would discard exactly what you need
 * to diagnose the failure. globalSetup recreates the database from scratch on
 * the next run, so nothing stale survives into a subsequent suite.
 */
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty.
}
