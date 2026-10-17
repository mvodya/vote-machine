import {join} from 'node:path';
import {runner} from 'node-pg-migrate';

// Run schema changes in one transaction under the migration lock
export async function runMigrations({
  databaseUrl = process.env.DATABASE_URL,
  dir = join(import.meta.dirname, 'migrations'),
  direction = 'up',
  count = direction === 'down' ? 1 : Infinity,
} = {}) {
  if (!['up', 'down'].includes(direction)) {
    throw new Error('Migration direction must be up or down');
  }
  // Check settings before opening a connection
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required');
  }
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  return runner({
    databaseUrl: {
      connectionString: databaseUrl,
      application_name: 'vote_machine_migrate',
      connectionTimeoutMillis: 10000,
      options: '-c timezone=UTC -c lock_timeout=30000',
    },
    dir,
    migrationsTable: 'schema_migrations',
    migrationsSchema: 'public',
    schema: 'public',
    direction,
    count,
    checkOrder: true,
    singleTransaction: true,
    noLock: false,
    advisoryLockMode: 'wait',
    // Keep connection details and query data out of logs
    logger: {debug() {}, info() {}, warn() {}, error() {}},
  });
}

// Imports from tests must not change the database
if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    // The default container command always applies migrations
    if (args.length > 1 || (args.length === 1 && args[0] !== 'down')) {
      throw new Error('Use no arguments or down');
    }
    const direction = args[0] === 'down' ? 'down' : 'up';
    const applied = await runMigrations({direction});
    const action = direction === 'down' ? 'Reverted' : 'Applied';
    console.log(`${action} ${applied.length} migrations`);
  } catch (error) {
    const code = /^[A-Z0-9]{5}$/.test(error.code ?? '')
      ? ` (${error.code})`
      : '';
    const safeMessages = new Set([
      'DATABASE_URL is required',
      'DATABASE_URL must use PostgreSQL',
      'Use no arguments or down',
      'Migration direction must be up or down',
    ]);
    const message = safeMessages.has(error.message)
      ? error.message
      : 'Migration failed';
    console.error(`${message}${code}`);
    process.exitCode = 1;
  }
}
