// Database maintenance job

import 'dotenv/config';
import { fileURLToPath } from 'url';
import sql from './client.js';

export async function runCleanup() {
  const startTime = Date.now();
  console.log(`[Cleanup] Starting at ${new Date().toISOString()}`);

  let totalExpired = 0;
  let totalPruned = 0;
  let totalOrphaned = 0;

  try {
    const expireResult = await sql`
      UPDATE restore_requests
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending'
        AND (expires_at < NOW() OR created_at < NOW() - INTERVAL '10 minutes')
      RETURNING id
    `;
    totalExpired = expireResult.length;
    console.log(`[Cleanup] Expired ${totalExpired} stale restore requests`);

    const users = await sql`
      SELECT id, snapshot_retention FROM users
      WHERE snapshot_retention > 0
    `;

    for (const user of users) {
      const devices = await sql`
        SELECT id FROM devices WHERE user_id = ${user.id}
      `;

      for (const device of devices) {
        const pruneResult = await sql`
          DELETE FROM snapshots
          WHERE device_id = ${device.id}
            AND id NOT IN (
              SELECT id FROM snapshots
              WHERE device_id = ${device.id}
              ORDER BY captured_at DESC
              LIMIT ${user.snapshot_retention}
            )
          RETURNING id
        `;
        totalPruned += pruneResult.length;
      }
    }

    if (totalPruned > 0) {
      console.log(`[Cleanup] Pruned ${totalPruned} old snapshots`);
    }

    const orphanResult = await sql`
      DELETE FROM devices
      WHERE id IN (
        SELECT d.id FROM devices d
        LEFT JOIN snapshots s ON s.device_id = d.id
        WHERE s.id IS NULL
          AND d.last_seen < NOW() - INTERVAL '90 days'
      )
      RETURNING id
    `;
    totalOrphaned = orphanResult.length;

    const [stats] = await sql`
      SELECT
        (SELECT COUNT(*) FROM users)            AS user_count,
        (SELECT COUNT(*) FROM devices)          AS device_count,
        (SELECT COUNT(*) FROM snapshots)        AS snapshot_count,
        (SELECT COUNT(*) FROM restore_requests) AS restore_count
    `;

    const duration = Date.now() - startTime;
    console.log(`[Cleanup] Complete in ${duration}ms | ${stats.user_count} users | ${stats.device_count} devices | ${stats.snapshot_count} snapshots`);

  } catch (err) {
    console.error('[Cleanup] Error:', err);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCleanup().then(() => sql.end());
}
