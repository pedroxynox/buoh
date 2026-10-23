import { ConfigError, loadConfig } from '../config.js';
import { migrate } from '../postgres/migrate.js';
import { createPool } from '../postgres/metadata-store.js';

/** `pnpm --filter @buoh/market-data-worker run db:migrate`: aplica migraciones pendientes. */
async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const pool = createPool(config.postgres);
  try {
    const result = await migrate(pool);
    console.log(JSON.stringify({ ...result, status: 'migrated' }));
    return 0;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main();
