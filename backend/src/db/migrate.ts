/**
 * src/db/migrate.ts
 *
 * This script creates all the database tables.
 * Run it once with: npm run db:migrate
 *
 * TABLES WE CREATE:
 *
 * 1. users
 *    - Stores account info
 *    - encrypted_master_key = the user's master key, encrypted with their password
 *    - master_key_iv = the IV (initialization vector) used during encryption
 *    - salt = random bytes used during PBKDF2 key derivation (not secret)
 *
 * 2. devices
 *    - Each browser install registers as a device
 *    - Lets you see "MacBook Chrome", "Work Firefox", etc.
 *
 * 3. snapshots
 *    - Encrypted tab state blobs
 *    - We don't store URLs, titles, or any readable data here
 *    - Just: who sent it, when, and the encrypted blob
 *
 * IMPORTANT: This script is safe to run multiple times.
 * We use "CREATE TABLE IF NOT EXISTS" so it won't crash if tables already exist.
 */

import sql from './client';

async function migrate() {
  console.log('🔧 Running database migrations...\n');

  try {
    // ─── TABLE 1: users ──────────────────────────────────────────────────────
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email               TEXT UNIQUE NOT NULL,

        -- Password is NEVER stored. We store a bcrypt hash instead.
        -- Actually in our zero-knowledge model, we don't even store the hash —
        -- we use a different approach: the encrypted_master_key itself proves
        -- you know the password (if decryption works, password was correct).
        -- But for login convenience, we store a password hash for quick auth.
        password_hash       TEXT NOT NULL,

        -- The user's master key, encrypted with their password-derived key.
        -- This is a hex string of the encrypted bytes.
        -- Server cannot read this without knowing the password.
        encrypted_master_key TEXT NOT NULL,

        -- The IV (Initialization Vector) used when encrypting the master key.
        -- AES-GCM requires a unique IV per encryption. It's not secret.
        master_key_iv       TEXT NOT NULL,

        -- Random salt used in PBKDF2 key derivation.
        -- Stored so we can re-derive the wrapping key during login.
        -- Not secret — just prevents rainbow table attacks.
        salt                TEXT NOT NULL,

        created_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at          TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );
    `;
    console.log('✅ Table "users" ready');

    // ─── TABLE 2: devices ─────────────────────────────────────────────────────
    await sql`
      CREATE TABLE IF NOT EXISTS devices (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- Human-readable name shown in the UI (e.g. "MacBook Chrome")
        device_name TEXT NOT NULL,

        -- We track when we last received a snapshot from this device
        last_seen   TIMESTAMPTZ DEFAULT NOW() NOT NULL,

        created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );
    `;
    console.log('✅ Table "devices" ready');

    // ─── TABLE 3: snapshots ──────────────────────────────────────────────────
    await sql`
      CREATE TABLE IF NOT EXISTS snapshots (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

        -- When this snapshot was taken (set by the client, not server)
        captured_at  TIMESTAMPTZ NOT NULL,

        -- The IV used when encrypting this snapshot blob.
        -- Every snapshot needs a fresh IV — we generate one per snapshot.
        iv           TEXT NOT NULL,

        -- The actual encrypted tab data. Stored as base64 string.
        -- Could be stored in Cloudflare R2 for large blobs (Phase 2).
        encrypted_blob TEXT NOT NULL,

        created_at   TIMESTAMPTZ DEFAULT NOW() NOT NULL
      );
    `;
    console.log('✅ Table "snapshots" ready');

    // ─── INDEX for fast queries ───────────────────────────────────────────────
    // When the mobile app asks for latest snapshots per device,
    // this index makes that query fast.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_snapshots_user_device
        ON snapshots(user_id, device_id, captured_at DESC);
    `;
    console.log('✅ Index on snapshots ready');

    // ─── INDEX for device lookups ─────────────────────────────────────────────
    await sql`
      CREATE INDEX IF NOT EXISTS idx_devices_user
        ON devices(user_id);
    `;
    console.log('✅ Index on devices ready');

    // ─── TABLE 4: restore_requests ────────────────────────────────────────────
    // Phase 3: PWA sends a restore request targeting a specific device.
    // The extension polls for pending requests and opens the tabs locally.
    //
    // HOW IT WORKS:
    // 1. User taps "Restore to Desktop" on PWA (targets device X)
    // 2. PWA posts to /restore with the snapshot_id and target device_id
    // 3. Backend stores the request with status "pending"
    // 4. Extension polls GET /restore/pending every 5 seconds
    // 5. Extension finds the request, decrypts the snapshot, opens tabs
    // 6. Extension marks the request "completed"
    // 7. PWA polls GET /restore/:id and shows "Session restored!" when completed
    //
    // WHY NOT WEBSOCKETS?
    // Service workers can't hold WebSocket connections.
    // Short polling (5s) is simple, reliable, and sufficient for this use case.
    await sql`
      CREATE TABLE IF NOT EXISTS restore_requests (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- Which device should restore the session
        target_device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

        -- Which snapshot to restore (null = latest for that device)
        snapshot_id UUID REFERENCES snapshots(id) ON DELETE SET NULL,

        -- Status lifecycle: pending → completed | failed | expired
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed', 'expired')),

        -- Set by the extension after attempting restore
        error_msg   TEXT,

        created_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,

        -- Auto-expire requests after 5 minutes (extension may be offline)
        expires_at  TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '5 minutes') NOT NULL
      );
    `;
    console.log('✅ Table "restore_requests" ready');

    await sql`
      CREATE INDEX IF NOT EXISTS idx_restore_device_status
        ON restore_requests(target_device_id, status, expires_at);
    `;
    console.log('✅ Index on restore_requests ready');

    console.log('\n🎉 All migrations complete! Your database is ready.');
    console.log('\nNext step: npm run dev\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    console.error('\nMake sure:');
    console.error('  1. Your DATABASE_URL is correct in .env');
    console.error('  2. PostgreSQL is running');
    console.error('  3. The database exists (for local: createdb vaulttabs)\n');
    process.exit(1);
  }

  // Close the connection when done
  await sql.end();
}

// Run it
migrate();