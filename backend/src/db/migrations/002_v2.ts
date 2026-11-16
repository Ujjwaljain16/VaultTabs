// 002 — v2 schema: KDF versioning + token revocation, case-insensitive emails, saved sessions,
// encrypted restore payloads, no plaintext URLs / error messages / device fingerprints.

import type { Migration } from './index.js';

export const v2: Migration = {
  id: '002_v2',
  async up(tx) {
    // ── users ────────────────────────────────────────────────────────────────────────────────
    await tx.unsafe(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS kdf_version    INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS kdf_iterations INTEGER NOT NULL DEFAULT 100000,
        ADD COLUMN IF NOT EXISTS token_version  INTEGER NOT NULL DEFAULT 0;
    `);

    // Emails become case-insensitive. Refuse to guess which of two case-variant accounts wins.
    const duplicates = await tx<{ email: string; n: number }[]>`
      SELECT lower(btrim(email)) AS email, COUNT(*)::int AS n
      FROM users
      GROUP BY lower(btrim(email))
      HAVING COUNT(*) > 1
      ORDER BY 1
      LIMIT 20
    `;
    if (duplicates.length > 0) {
      const list = duplicates.map(d => `${d.email} (${d.n} accounts)`).join(', ');
      throw new Error(
        `Migration 002_v2 cannot make emails case-insensitive: these addresses exist with different ` +
          `capitalisation: ${list}. Decide which account to keep for each, delete or rename the others ` +
          `(e.g. UPDATE users SET email = 'old+' || email WHERE id = '<id>'), then run the migration again.`,
      );
    }

    await tx.unsafe(`
      UPDATE users SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_lowercase;
      ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

      -- 0 used to mean "unlimited": map it to the new maximum, clamp everything else.
      UPDATE users SET snapshot_retention = 500 WHERE snapshot_retention <= 0;
      UPDATE users SET snapshot_retention = 500 WHERE snapshot_retention > 500;
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_snapshot_retention_range;
      ALTER TABLE users ADD CONSTRAINT users_snapshot_retention_range CHECK (snapshot_retention BETWEEN 1 AND 500);

      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kdf_version_check;
      ALTER TABLE users ADD CONSTRAINT users_kdf_version_check CHECK (kdf_version IN (1, 2));
    `);

    // ── snapshots ────────────────────────────────────────────────────────────────────────────
    await tx.unsafe(`
      ALTER TABLE snapshots
        ADD COLUMN IF NOT EXISTS enc_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS pinned      BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS label_enc   TEXT,
        ADD COLUMN IF NOT EXISTS label_iv    TEXT,
        ADD COLUMN IF NOT EXISTS size_bytes  INTEGER;

      UPDATE snapshots SET size_bytes = octet_length(encrypted_blob) WHERE size_bytes IS NULL;
      ALTER TABLE snapshots ALTER COLUMN size_bytes SET DEFAULT 0;
      ALTER TABLE snapshots ALTER COLUMN size_bytes SET NOT NULL;

      ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_enc_version_check;
      ALTER TABLE snapshots ADD CONSTRAINT snapshots_enc_version_check CHECK (enc_version IN (1, 2));

      CREATE INDEX IF NOT EXISTS idx_snapshots_user_pinned ON snapshots (user_id, pinned, captured_at DESC);
    `);

    // ── restore_requests ─────────────────────────────────────────────────────────────────────
    // target_url and error_msg were plaintext; source_device_id was unused (and its FK had no
    // ON DELETE action, which blocked deleting devices).
    await tx.unsafe(`
      ALTER TABLE restore_requests
        ADD COLUMN IF NOT EXISTS encrypted_payload TEXT,
        ADD COLUMN IF NOT EXISTS payload_iv        TEXT,
        ADD COLUMN IF NOT EXISTS error_code        TEXT,
        DROP COLUMN IF EXISTS target_url,
        DROP COLUMN IF EXISTS error_msg,
        DROP COLUMN IF EXISTS source_device_id;

      ALTER TABLE restore_requests DROP CONSTRAINT IF EXISTS restore_requests_error_code_check;
      ALTER TABLE restore_requests ADD CONSTRAINT restore_requests_error_code_check CHECK (
        error_code IS NULL OR error_code IN
          ('master_key_missing', 'decrypt_failed', 'empty_snapshot', 'unsafe_url', 'open_failed', 'unknown')
      );
      ALTER TABLE restore_requests DROP CONSTRAINT IF EXISTS restore_requests_payload_pair_check;
      ALTER TABLE restore_requests ADD CONSTRAINT restore_requests_payload_pair_check CHECK (
        (encrypted_payload IS NULL) = (payload_iv IS NULL)
      );

      CREATE INDEX IF NOT EXISTS idx_restore_user ON restore_requests (user_id);
      CREATE INDEX IF NOT EXISTS idx_restore_created ON restore_requests (created_at);
      CREATE INDEX IF NOT EXISTS idx_restore_snapshot ON restore_requests (snapshot_id);
    `);

    // ── devices ──────────────────────────────────────────────────────────────────────────────
    await tx.unsafe(`
      ALTER TABLE devices DROP COLUMN IF EXISTS fingerprint;
      CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen);
    `);
  },
};
