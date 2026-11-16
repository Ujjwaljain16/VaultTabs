import type { PendingRestoreDetail, RestoreErrorCode, RestoreRequest } from '@vaulttabs/shared';
import type { Sql } from '../db/client.js';

/** Postgres NOTIFY channel; payload is `{ "id": <request id>, "d": <target device id> }` only. */
export const RESTORE_CHANNEL = 'vaulttabs_restore';
/**
 * A request waits this long for its target browser. If that browser is closed, the tab opens the
 * next time it starts (extensions cannot launch a closed browser).
 */
export const RESTORE_TTL_MINUTES = 24 * 60;
/** At most this many requests queue up per target device; older ones expire. */
export const RESTORE_QUEUE_MAX = 50;

export type RestoreContent = { snapshotId: string } | { encryptedPayload: string; payloadIv: string };

export type CompleteResult = 'ok' | 'not_found' | 'not_pending';

interface PendingRow {
  id: string;
  target_device_id: string;
  created_at: Date;
  expires_at: Date;
  encrypted_payload: string | null;
  payload_iv: string | null;
  s_id: string | null;
  s_device_id: string | null;
  s_captured_at: Date | null;
  s_iv: string | null;
  s_encrypted_blob: string | null;
  s_enc_version: number | null;
}

export class RestoreRepository {
  constructor(private readonly sql: Sql) {}

  /**
   * Queue a request for the target device (keeping at most RESTORE_QUEUE_MAX pending) and NOTIFY
   * listeners on commit. The caller must already have checked that the target device and snapshot are the
   * user's.
   */
  async create(userId: string, targetDeviceId: string, content: RestoreContent): Promise<RestoreRequest> {
    const snapshotId = 'snapshotId' in content ? content.snapshotId : null;
    const encryptedPayload = 'encryptedPayload' in content ? content.encryptedPayload : null;
    const payloadIv = 'payloadIv' in content ? content.payloadIv : null;

    return this.sql.begin(async tx => {
      const [request] = await tx<RestoreRequest[]>`
        INSERT INTO restore_requests
          (user_id, target_device_id, snapshot_id, encrypted_payload, payload_iv, status, expires_at)
        VALUES (
          ${userId}, ${targetDeviceId}, ${snapshotId}, ${encryptedPayload}, ${payloadIv}, 'pending',
          NOW() + make_interval(mins => ${RESTORE_TTL_MINUTES})
        )
        RETURNING id, target_device_id, snapshot_id, status, error_code, created_at, expires_at
      `;
      // Bound the queue: expire the oldest pending requests beyond the cap.
      await tx`
        UPDATE restore_requests SET status = 'expired', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM restore_requests
          WHERE target_device_id = ${targetDeviceId} AND user_id = ${userId} AND status = 'pending'
          ORDER BY created_at DESC
          OFFSET ${RESTORE_QUEUE_MAX}
        )
      `;
      // Delivered to every instance's listener when the transaction commits.
      await tx`SELECT pg_notify(${RESTORE_CHANNEL}, ${JSON.stringify({ id: request!.id, d: targetDeviceId })})`;
      return request!;
    });
  }

  /** Live pending requests for one of the user's devices, oldest first, with their snapshots. */
  async findPendingDetails(
    userId: string,
    targetDeviceId: string,
    onlyId?: string,
  ): Promise<PendingRestoreDetail[]> {
    const rows = await this.sql<PendingRow[]>`
      SELECT
        r.id, r.target_device_id, r.created_at, r.expires_at, r.encrypted_payload, r.payload_iv,
        s.id AS s_id, s.device_id AS s_device_id, s.captured_at AS s_captured_at, s.iv AS s_iv,
        s.encrypted_blob AS s_encrypted_blob, s.enc_version AS s_enc_version
      FROM restore_requests r
      LEFT JOIN snapshots s ON s.id = r.snapshot_id AND s.user_id = r.user_id
      WHERE r.target_device_id = ${targetDeviceId}
        AND r.user_id = ${userId}
        AND r.status = 'pending'
        AND r.expires_at > NOW()
        AND (s.id IS NOT NULL OR r.encrypted_payload IS NOT NULL)
        ${onlyId ? this.sql`AND r.id = ${onlyId}` : this.sql``}
      ORDER BY r.created_at ASC
      LIMIT ${RESTORE_QUEUE_MAX}
    `;
    return rows.map(toDetail);
  }

  /** Status as the client should see it: a pending request past its expiry reads as expired. */
  async findOwned(userId: string, id: string): Promise<RestoreRequest | undefined> {
    const [row] = await this.sql<RestoreRequest[]>`
      SELECT
        id, target_device_id, snapshot_id,
        CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status,
        error_code, created_at, expires_at
      FROM restore_requests
      WHERE id = ${id} AND user_id = ${userId}
    `;
    return row;
  }

  async complete(
    userId: string,
    id: string,
    status: 'completed' | 'failed',
    errorCode: RestoreErrorCode | null,
  ): Promise<CompleteResult> {
    const updated = await this.sql`
      UPDATE restore_requests r
      SET status = ${status}, error_code = ${errorCode}, updated_at = NOW()
      FROM devices d
      WHERE r.id = ${id}
        AND r.user_id = ${userId}
        AND r.status = 'pending'
        AND d.id = r.target_device_id AND d.user_id = ${userId}
      RETURNING r.id
    `;
    if (updated.length > 0) return 'ok';
    const [exists] = await this.sql`SELECT 1 FROM restore_requests WHERE id = ${id} AND user_id = ${userId}`;
    return exists ? 'not_pending' : 'not_found';
  }
}

function toDetail(row: PendingRow): PendingRestoreDetail {
  return {
    id: row.id,
    target_device_id: row.target_device_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    snapshot: row.s_id
      ? {
          id: row.s_id,
          device_id: row.s_device_id!,
          captured_at: row.s_captured_at!,
          iv: row.s_iv!,
          encrypted_blob: row.s_encrypted_blob!,
          enc_version: row.s_enc_version!,
        }
      : null,
    encrypted_payload: row.encrypted_payload,
    payload_iv: row.payload_iv,
  };
}
