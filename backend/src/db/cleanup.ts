// Database maintenance, set-based (a fixed number of statements regardless of user count).
//
// Runs in-process every CLEANUP_INTERVAL_MINUTES (see server.ts) and on demand:
//   npm run db:cleanup            (dev)
//   node dist/db/cleanup.js       (production)
// A session-level advisory lock makes concurrent runs (several instances) skip instead of race.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Sql } from './client.js';
import type { Logger } from '../logger.js';

const CLEANUP_LOCK_KEY = 7_265_840_212;
export const RESTORE_HISTORY_DAYS = 7;
export const IDLE_DEVICE_DAYS = 180;

export interface CleanupResult {
  skipped: boolean;
  expiredRestores: number;
  deletedRestores: number;
  prunedSnapshots: number;
  deletedDevices: number;
}

export async function runCleanup(sql: Sql, log?: Logger): Promise<CleanupResult> {
  const started = Date.now();
  const result: CleanupResult = {
    skipped: false,
    expiredRestores: 0,
    deletedRestores: 0,
    prunedSnapshots: 0,
    deletedDevices: 0,
  };

  // The lock is per session: reserve one connection for lock, work and unlock.
  const conn = await sql.reserve();
  try {
    const [lock] = await conn<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${CLEANUP_LOCK_KEY}::bigint) AS locked
    `;
    if (!lock?.locked) {
      log?.info('cleanup: another instance is running it, skipping');
      return { ...result, skipped: true };
    }

    try {
      result.expiredRestores = (
        await conn`
          UPDATE restore_requests SET status = 'expired', updated_at = NOW()
          WHERE status = 'pending' AND expires_at <= NOW()
          RETURNING id
        `
      ).length;

      result.deletedRestores = (
        await conn`
          DELETE FROM restore_requests
          WHERE created_at < NOW() - make_interval(days => ${RESTORE_HISTORY_DAYS})
          RETURNING id
        `
      ).length;

      // Per device, keep the newest `snapshot_retention` unpinned snapshots of its owner.
      result.prunedSnapshots = (
        await conn`
          DELETE FROM snapshots s
          USING (
            SELECT sn.id,
                   row_number() OVER (PARTITION BY sn.device_id ORDER BY sn.captured_at DESC, sn.id DESC) AS rn,
                   u.snapshot_retention
            FROM snapshots sn
            JOIN users u ON u.id = sn.user_id
            WHERE NOT sn.pinned
          ) ranked
          WHERE s.id = ranked.id AND ranked.rn > ranked.snapshot_retention
          RETURNING s.id
        `
      ).length;

      result.deletedDevices = (
        await conn`
          DELETE FROM devices d
          WHERE d.last_seen < NOW() - make_interval(days => ${IDLE_DEVICE_DAYS})
            AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.device_id = d.id)
          RETURNING d.id
        `
      ).length;
    } finally {
      await conn`SELECT pg_advisory_unlock(${CLEANUP_LOCK_KEY}::bigint)`;
    }

    log?.info({ ...result, durationMs: Date.now() - started }, 'cleanup complete');
    return result;
  } finally {
    conn.release();
  }
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
    await runCleanup(sql, log);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(err => {
    process.stderr.write(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
