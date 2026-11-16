// Versioned schema migrations.
//
//   npm run db:migrate            (dev, via tsx)
//   node dist/db/migrate.js       (production / Docker; runs before the server starts)
//
// Each migration runs in its own transaction while holding a transaction-scoped advisory lock, so
// several instances starting at once apply every migration exactly once.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Sql } from './client.js';
import { migrations } from './migrations/index.js';
import type { Logger } from '../logger.js';

/** Arbitrary constant identifying "VaultTabs schema migrations" among advisory locks. */
const MIGRATION_LOCK_KEY = 7_265_840_211;

export interface RunMigrationsOptions {
  log?: Logger;
  /** Stop after applying this migration id (tests). */
  until?: string;
}

/** Applies all pending migrations; returns the ids that were applied by this call. */
export async function runMigrations(sql: Sql, options: RunMigrationsOptions = {}): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of migrations) {
    const didApply = await sql.begin(async tx => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
      await tx`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      const [existing] = await tx`SELECT 1 FROM schema_migrations WHERE id = ${migration.id}`;
      if (existing) return false;
      await migration.up(tx);
      await tx`INSERT INTO schema_migrations (id) VALUES (${migration.id})`;
      return true;
    });
    if (didApply) {
      applied.push(migration.id);
      options.log?.info({ migration: migration.id }, 'migration applied');
    }
    if (options.until && migration.id === options.until) break;
  }
  return applied;
}

async function main(): Promise<void> {
  const { config: loadDotenv } = await import('dotenv');
  loadDotenv({ override: false, quiet: true });
  const { loadDatabaseConfig } = await import('../config.js');
  const { createSql } = await import('./client.js');
  const { createCliLogger } = await import('../logger.js');

  const log = createCliLogger();
  const sql = createSql(loadDatabaseConfig(), { max: 1 });
  try {
    const applied = await runMigrations(sql, { log });
    log.info({ applied }, applied.length ? 'migrations complete' : 'database schema is up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
