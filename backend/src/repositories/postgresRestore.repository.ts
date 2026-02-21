import { IRestoreRepository } from '../interfaces/restore.repository.js';
import { RestoreRequest } from '../interfaces/models.js';
import sql from '../db/client.js';

export class PostgresRestoreRepository implements IRestoreRepository {
  async findById(id: string): Promise<RestoreRequest | undefined> {
    const [request] = await sql<RestoreRequest[]>`
      SELECT * FROM restore_requests WHERE id = ${id} LIMIT 1
    `;
    return request;
  }

  async findPendingByTargetDeviceWithSnapshot(userId: string, targetDeviceId: string): Promise<any | undefined> {
    const [pending] = await sql<any[]>`
      SELECT
        r.id,
        r.status,
        r.created_at,
        r.expires_at,
        s.id          AS snapshot_id,
        s.iv          AS snapshot_iv,
        s.encrypted_blob
      FROM restore_requests r
      JOIN snapshots s ON s.id = r.snapshot_id
      WHERE r.target_device_id = ${targetDeviceId}
        AND r.user_id          = ${userId}
        AND r.status           = 'pending'
        AND r.expires_at       > NOW()
      ORDER BY r.created_at DESC
      LIMIT 1
    `;
    return pending;
  }

  async expireExistingPending(targetDeviceId: string): Promise<void> {
    await sql`
      UPDATE restore_requests
      SET status = 'expired'
      WHERE target_device_id = ${targetDeviceId}
        AND status = 'pending'
    `;
  }

  async findPendingByTargetDevice(targetDeviceId: string): Promise<RestoreRequest | undefined> {
    const [request] = await sql<RestoreRequest[]>`
      SELECT * FROM restore_requests
      WHERE target_device_id = ${targetDeviceId}
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return request;
  }

  async create(request: Omit<RestoreRequest, 'id' | 'created_at' | 'status' | 'user_id'> & { user_id: string }): Promise<RestoreRequest> {
    const [newRequest] = await sql<RestoreRequest[]>`
      INSERT INTO restore_requests (
        user_id,
        source_device_id,
        target_device_id,
        snapshot_id,
        status,
        expires_at
      ) VALUES (
        ${request.user_id},
        ${request.source_device_id},
        ${request.target_device_id},
        ${request.snapshot_id},
        'pending',
        ${request.expires_at}
      )
      RETURNING *
    `;
    return newRequest;
  }

  async updateStatus(id: string, status: RestoreRequest['status'], errorMsg?: string): Promise<void> {
    await sql`
      UPDATE restore_requests
      SET status = ${status}, error_msg = ${errorMsg || null}
      WHERE id = ${id}
    `;
  }
}
