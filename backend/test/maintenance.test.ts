// Migrations from the legacy schema, and the cleanup job.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCleanup } from '../src/db/cleanup.js';
import { runMigrations } from '../src/db/migrate.js';
import { adminSql, resetDatabase } from './helpers.js';
import type { Sql } from '../src/db/client.js';

let sql: Sql;
beforeAll(() => {
  sql = adminSql();
});
afterAll(async () => sql.end({ timeout: 5 }));

async function legacyUser(email: string, retention = 50): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, encrypted_master_key, master_key_iv, salt, snapshot_retention)
    VALUES (${email}, 'aa:bb', 'k', 'iv', 's', ${retention}) RETURNING id`;
  return row!.id;
}

describe('migrations', () => {
  it('upgrades a legacy database (001 → 002) and is idempotent', async () => {
    await resetDatabase(sql, { migrate: false });
    expect(await runMigrations(sql, { until: '001_baseline' })).toEqual(['001_baseline']);

    const userId = await legacyUser('  Mixed.Case@Example.COM ', 0);
    await legacyUser('big@example.com', 9000);
    const [device] = await sql<{ id: string }[]>`
      INSERT INTO devices (user_id, device_name, fingerprint) VALUES (${userId}, 'old', 'fp') RETURNING id`;
    const [snap] = await sql<{ id: string }[]>`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob)
      VALUES (${userId}, ${device!.id}, NOW(), 'iv', 'QUJD') RETURNING id`;
    await sql`
      INSERT INTO restore_requests (user_id, target_device_id, snapshot_id, source_device_id, target_url, error_msg)
      VALUES (${userId}, ${device!.id}, ${snap!.id}, ${device!.id}, 'https://plain.test', 'oops')`;

    expect(await runMigrations(sql)).toEqual(['002_v2']);
    expect(await runMigrations(sql)).toEqual([]);

    const users = await sql<
      { email: string; snapshot_retention: number; kdf_version: number; token_version: number }[]
    >`
      SELECT email, snapshot_retention, kdf_version, token_version FROM users ORDER BY email`;
    expect(users).toEqual([
      { email: 'big@example.com', snapshot_retention: 500, kdf_version: 1, token_version: 0 },
      { email: 'mixed.case@example.com', snapshot_retention: 500, kdf_version: 1, token_version: 0 },
    ]);
    const [s] = await sql<{ enc_version: number; pinned: boolean; size_bytes: number }[]>`
      SELECT enc_version, pinned, size_bytes FROM snapshots`;
    expect(s).toEqual({ enc_version: 1, pinned: false, size_bytes: 4 });

    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('target_url', 'error_msg', 'fingerprint', 'source_device_id')`;
    expect(columns).toEqual([]);

    // Constraints hold.
    await expect(sql`INSERT INTO users (email, password_hash, encrypted_master_key, master_key_iv, salt)
      VALUES ('MIXED.case@example.com', 'x', 'k', 'iv', 's')`).rejects.toThrow();
    await expect(sql`UPDATE users SET snapshot_retention = 0`).rejects.toThrow();
    // Deleting a device referenced by restore requests works (old FK had no ON DELETE).
    await sql`DELETE FROM devices WHERE id = ${device!.id}`;
  });

  it('refuses to merge case-duplicate emails with an actionable error', async () => {
    await resetDatabase(sql, { migrate: false });
    await runMigrations(sql, { until: '001_baseline' });
    await legacyUser('dup@example.com');
    await legacyUser('DUP@example.com');
    await expect(runMigrations(sql)).rejects.toThrow(
      /dup@example\.com \(2 accounts\).*run the migration again/s,
    );
    // Nothing from 002 was applied.
    const [row] = await sql`SELECT 1 FROM schema_migrations WHERE id = '002_v2'`;
    expect(row).toBeUndefined();
  });

  it('serializes concurrent runners', async () => {
    await resetDatabase(sql, { migrate: false });
    const other = adminSql();
    try {
      const [a, b] = await Promise.all([runMigrations(sql), runMigrations(other)]);
      expect([...a, ...b].sort()).toEqual(['001_baseline', '002_v2']);
    } finally {
      await other.end({ timeout: 5 });
    }
  });
});

describe('cleanup', () => {
  it('expires/deletes restores, prunes beyond retention (keeping pinned), drops idle empty devices', async () => {
    await resetDatabase(sql);
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, encrypted_master_key, master_key_iv, salt, snapshot_retention, kdf_version)
      VALUES ('clean@example.com', 'x', 'k', 'iv', 's', 2, 2) RETURNING id`;
    const uid = user!.id;
    const [active] = await sql<
      { id: string }[]
    >`INSERT INTO devices (user_id, device_name) VALUES (${uid}, 'active') RETURNING id`;
    await sql`
      INSERT INTO devices (user_id, device_name, last_seen) VALUES (${uid}, 'idle', NOW() - INTERVAL '200 days') RETURNING id`;
    const [idleWithData] = await sql<{ id: string }[]>`
      INSERT INTO devices (user_id, device_name, last_seen) VALUES (${uid}, 'idle2', NOW() - INTERVAL '200 days') RETURNING id`;

    // 5 snapshots on `active` (oldest pinned) + 1 on idleWithData.
    await sql`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob, enc_version, pinned, size_bytes)
      SELECT ${uid}, ${active!.id}, NOW() - make_interval(mins => g), 'iv', 'QUJD', 2, g = 5, 4
      FROM generate_series(1, 5) AS g`;
    await sql`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob, enc_version, size_bytes)
      VALUES (${uid}, ${idleWithData!.id}, NOW() - INTERVAL '200 days', 'iv', 'QUJD', 2, 4)`;

    await sql`
      INSERT INTO restore_requests (user_id, target_device_id, encrypted_payload, payload_iv, status, created_at, expires_at)
      VALUES
        (${uid}, ${active!.id}, 'QUJD', 'iv', 'pending', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '55 minutes'),
        (${uid}, ${active!.id}, 'QUJD', 'iv', 'completed', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'),
        (${uid}, ${active!.id}, 'QUJD', 'iv', 'pending', NOW(), NOW() + INTERVAL '5 minutes')`;

    const result = await runCleanup(sql);
    expect(result).toEqual({
      skipped: false,
      expiredRestores: 1,
      deletedRestores: 1,
      prunedSnapshots: 2,
      deletedDevices: 1,
    });

    const snaps = await sql<
      { pinned: boolean }[]
    >`SELECT pinned FROM snapshots WHERE device_id = ${active!.id}`;
    expect(snaps).toHaveLength(3);
    expect(snaps.filter(s => s.pinned)).toHaveLength(1);
    const devices = await sql<
      { device_name: string }[]
    >`SELECT device_name FROM devices ORDER BY device_name`;
    expect(devices.map(d => d.device_name)).toEqual(['active', 'idle2']);
    const restores = await sql<{ status: string }[]>`SELECT status FROM restore_requests ORDER BY created_at`;
    expect(restores.map(r => r.status)).toEqual(['expired', 'pending']);

    // Second run has nothing to do.
    expect(await runCleanup(sql)).toMatchObject({
      expiredRestores: 0,
      deletedRestores: 0,
      prunedSnapshots: 0,
      deletedDevices: 0,
    });
  });

  it('skips when another instance holds the lock', async () => {
    const other = adminSql();
    const conn = await other.reserve();
    try {
      await conn`SELECT pg_advisory_lock(7265840212::bigint)`;
      expect((await runCleanup(sql)).skipped).toBe(true);
      await conn`SELECT pg_advisory_unlock(7265840212::bigint)`;
    } finally {
      conn.release();
      await other.end({ timeout: 5 });
    }
  });
});
