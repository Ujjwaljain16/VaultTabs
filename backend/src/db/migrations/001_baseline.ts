// 001 — baseline: the schema as it existed before versioned migrations.
//
// Every statement is idempotent (IF NOT EXISTS) so databases created by the old ad-hoc migrate
// script pass through unchanged and are simply recorded as being at version 001.

import type { Migration } from './index.js';

export const baseline: Migration = {
  id: '001_baseline',
  async up(tx) {
    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email                         TEXT UNIQUE NOT NULL,
        password_hash                 TEXT NOT NULL,
        encrypted_master_key          TEXT NOT NULL,
        master_key_iv                 TEXT NOT NULL,
        salt                          TEXT NOT NULL,
        recovery_encrypted_master_key TEXT,
        recovery_key_iv               TEXT,
        recovery_key_salt             TEXT,
        recovery_key_hash             TEXT,
        snapshot_retention            INTEGER NOT NULL DEFAULT 50,
        created_at                    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at                    TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS snapshot_retention INTEGER NOT NULL DEFAULT 50,
        ADD COLUMN IF NOT EXISTS recovery_encrypted_master_key TEXT,
        ADD COLUMN IF NOT EXISTS recovery_key_iv TEXT,
        ADD COLUMN IF NOT EXISTS recovery_key_salt TEXT,
        ADD COLUMN IF NOT EXISTS recovery_key_hash TEXT;

      CREATE TABLE IF NOT EXISTS devices (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name TEXT NOT NULL,
        fingerprint TEXT,
        last_seen   TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      ALTER TABLE devices ADD COLUMN IF NOT EXISTS fingerprint TEXT;

      CREATE TABLE IF NOT EXISTS snapshots (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        captured_at    TIMESTAMPTZ NOT NULL,
        iv             TEXT NOT NULL,
        encrypted_blob TEXT NOT NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_user_device ON snapshots(user_id, device_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_device_captured ON snapshots(device_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_user_captured ON snapshots(user_id, captured_at DESC);

      CREATE TABLE IF NOT EXISTS restore_requests (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        snapshot_id      UUID REFERENCES snapshots(id) ON DELETE SET NULL,
        status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
        error_msg        TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at       TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        expires_at       TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '5 minutes') NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_restore_device_status ON restore_requests(target_device_id, status, expires_at);

      ALTER TABLE restore_requests
        ADD COLUMN IF NOT EXISTS source_device_id UUID REFERENCES devices(id),
        ADD COLUMN IF NOT EXISTS target_url TEXT;
    `);
  },
};
