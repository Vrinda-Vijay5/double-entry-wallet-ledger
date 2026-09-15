/* eslint-disable no-console */
import 'dotenv/config';
import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }

  const pool = createPool(url, { max: 2 });
  try {
    const applied = await migrate(pool);
    if (applied.length === 0) {
      console.log('Database is already up to date.');
    } else {
      console.log(`Applied ${applied.length} migration(s):`);
      for (const name of applied) console.log(`  - ${name}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
