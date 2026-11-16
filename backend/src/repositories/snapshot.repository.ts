import type { SnapshotWithDevice } from '@vaulttabs/shared';
import type { Queryable, Sql } from '../db/client.js';

export interface NewSnapshot {
  device_id: string;
  captured_at: Date;
  iv: string;
  encrypted_blob: string;
  enc_version: number;
}

export interface SnapshotPatch {
  pinned?: boolean;
  /** undefined = leave unchanged; null = clear. Always set together with label_iv. */
  label?: { label_enc: string; label_iv: string } | null;
}

export type UpdateSnapshotResult =
  | { kind: 'ok'; snapshot: SnapshotWithDevice }
  | { kind: 'not_found' }
  | { kind: 'saved_limit' }
  | { kind: 'not_saved' };

export class SnapshotRepository {
  constructor(private readonly sql: Sql) {}

  private columns(q: Queryable) {
    return q`
      s.id, s.user_id, s.device_id, s.captured_at, s.iv, s.encrypted_blob, s.enc_version,
      s.pinned, s.label_enc, s.label_iv, s.created_at, d.device_name, d.last_seen
    `;
  }

  /**
   * Insert a snapshot for one of the user's devices, mark the device as seen and prune that
   * device's unpinned snapshots beyond the user's retention — atomically.
   * Returns undefined if the device does not exist or is not the user's.
   */
  async insertAndPrune(
    userId: string,
    snapshot: NewSnapshot,
  ): Promise<{ id: string; captured_at: Date } | undefined> {
    return this.sql.begin(async tx => {
      const [device] = await tx`
        UPDATE devices SET last_seen = NOW()
        WHERE id = ${snapshot.device_id} AND user_id = ${userId}
        RETURNING id
      `;
      if (!device) return undefined;

      const [row] = await tx<{ id: string; captured_at: Date }[]>`
        INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob, enc_version, size_bytes)
        VALUES (
          ${userId}, ${snapshot.device_id}, ${snapshot.captured_at}, ${snapshot.iv},
          ${snapshot.encrypted_blob}, ${snapshot.enc_version}, ${Buffer.byteLength(snapshot.encrypted_blob)}
        )
        RETURNING id, captured_at
      `;
      await this.pruneDevice(tx, userId, snapshot.device_id);
      return row;
    });
  }

  /** Delete one device's unpinned snapshots beyond the user's retention (single statement). */
  async pruneDevice(q: Queryable, userId: string, deviceId: string): Promise<number> {
    const rows = await q`
      DELETE FROM snapshots WHERE id IN (
        SELECT id FROM snapshots
        WHERE user_id = ${userId} AND device_id = ${deviceId} AND NOT pinned
        ORDER BY captured_at DESC, id DESC
        OFFSET (SELECT snapshot_retention FROM users WHERE id = ${userId})
      )
      RETURNING id
    `;
    return rows.length;
  }

  /** Apply the user's retention to all of their devices (single statement). */
  async pruneUser(userId: string): Promise<number> {
    const rows = await this.sql`
      DELETE FROM snapshots s
      USING (
        SELECT id, row_number() OVER (PARTITION BY device_id ORDER BY captured_at DESC, id DESC) AS rn
        FROM snapshots
        WHERE user_id = ${userId} AND NOT pinned
      ) ranked
      WHERE s.id = ranked.id
        AND ranked.rn > (SELECT snapshot_retention FROM users WHERE id = ${userId})
      RETURNING s.id
    `;
    return rows.length;
  }

  /** Newest snapshot of each of the user's devices. */
  async latest(userId: string): Promise<SnapshotWithDevice[]> {
    return this.sql<SnapshotWithDevice[]>`
      SELECT DISTINCT ON (s.device_id) ${this.columns(this.sql)}
      FROM snapshots s
      JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = ${userId}
      ORDER BY s.device_id, s.captured_at DESC, s.id DESC
    `;
  }

  /** Newest first; `deviceId` null = all devices. Fetches `limit` rows strictly before `before`. */
  async history(
    userId: string,
    deviceId: string | null,
    before: Date | null,
    limit: number,
  ): Promise<SnapshotWithDevice[]> {
    const sql = this.sql;
    return sql<SnapshotWithDevice[]>`
      SELECT ${this.columns(sql)}
      FROM snapshots s
      JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = ${userId}
        ${deviceId ? sql`AND s.device_id = ${deviceId}` : sql``}
        ${before ? sql`AND s.captured_at < ${before}` : sql``}
      ORDER BY s.captured_at DESC, s.id DESC
      LIMIT ${limit}
    `;
  }

  async saved(userId: string): Promise<SnapshotWithDevice[]> {
    return this.sql<SnapshotWithDevice[]>`
      SELECT ${this.columns(this.sql)}
      FROM snapshots s
      JOIN devices d ON d.id = s.device_id
      WHERE s.user_id = ${userId} AND s.pinned
      ORDER BY s.captured_at DESC, s.id DESC
    `;
  }

  async findOwned(
    userId: string,
    id: string,
    q: Queryable = this.sql,
  ): Promise<SnapshotWithDevice | undefined> {
    const [row] = await q<SnapshotWithDevice[]>`
      SELECT ${this.columns(q)}
      FROM snapshots s
      JOIN devices d ON d.id = s.device_id
      WHERE s.id = ${id} AND s.user_id = ${userId}
    `;
    return row;
  }

  async update(
    userId: string,
    id: string,
    patch: SnapshotPatch,
    maxSaved: number,
  ): Promise<UpdateSnapshotResult> {
    return this.sql.begin(async (tx): Promise<UpdateSnapshotResult> => {
      // Serialize pin operations per user so the saved-session limit cannot be raced.
      await tx`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      const [current] = await tx<{ pinned: boolean }[]>`
        SELECT pinned FROM snapshots WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
      `;
      if (!current) return { kind: 'not_found' };

      const pinned = patch.pinned ?? current.pinned;
      if (pinned && !current.pinned) {
        const [counted] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM snapshots WHERE user_id = ${userId} AND pinned
        `;
        const n = counted?.n ?? 0;
        if (n >= maxSaved) return { kind: 'saved_limit' };
      }
      if (!pinned && patch.label) return { kind: 'not_saved' };

      if (!pinned) {
        // Unpinning always drops the label.
        await tx`
          UPDATE snapshots SET pinned = false, label_enc = NULL, label_iv = NULL
          WHERE id = ${id} AND user_id = ${userId}
        `;
      } else if (patch.label !== undefined) {
        await tx`
          UPDATE snapshots
          SET pinned = true, label_enc = ${patch.label?.label_enc ?? null}, label_iv = ${patch.label?.label_iv ?? null}
          WHERE id = ${id} AND user_id = ${userId}
        `;
      } else {
        await tx`UPDATE snapshots SET pinned = true WHERE id = ${id} AND user_id = ${userId}`;
      }

      const snapshot = await this.findOwned(userId, id, tx);
      return snapshot ? { kind: 'ok', snapshot } : { kind: 'not_found' };
    });
  }

  async deleteOwned(userId: string, id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM snapshots WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
  }
}
