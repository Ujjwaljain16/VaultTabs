import { ISnapshotRepository } from '../interfaces/snapshot.repository.js';
import { Snapshot } from '../interfaces/models.js';
import sql from '../db/client.js';

export class PostgresSnapshotRepository implements ISnapshotRepository {
  async findLatestByUserId(userId: string): Promise<Snapshot[]> {
    // Get the latest snapshot per device using DISTINCT ON
    return await sql<Snapshot[]>`
      SELECT DISTINCT ON (device_id) *
      FROM snapshots
      WHERE user_id = ${userId}
      ORDER BY device_id, captured_at DESC
    `;
  }

  async findByDeviceId(deviceId: string): Promise<Snapshot | undefined> {
    const [snapshot] = await sql<Snapshot[]>`
      SELECT * FROM snapshots
      WHERE device_id = ${deviceId}
      ORDER BY captured_at DESC
      LIMIT 1
    `;
    return snapshot;
  }

  async findById(id: string): Promise<Snapshot | undefined> {
    const [snapshot] = await sql<Snapshot[]>`
      SELECT * FROM snapshots WHERE id = ${id} LIMIT 1
    `;
    return snapshot;
  }

  async getRecentByDevice(deviceId: string, limit: number): Promise<Snapshot[]> {
    return await sql<Snapshot[]>`
      SELECT * FROM snapshots
      WHERE device_id = ${deviceId}
      ORDER BY captured_at DESC
      LIMIT ${limit}
    `;
  }

  async create(snapshot: Omit<Snapshot, 'id' | 'created_at'>): Promise<Snapshot> {
    const [newSnapshot] = await sql<Snapshot[]>`
      INSERT INTO snapshots (user_id, device_id, captured_at, iv, encrypted_blob)
      VALUES (${snapshot.user_id}, ${snapshot.device_id}, ${snapshot.captured_at}, ${snapshot.iv}, ${snapshot.encrypted_blob})
      RETURNING *
    `;
    return newSnapshot;
  }

  async deleteOldSnapshots(deviceId: string, keepCount: number): Promise<void> {
    await sql`
      DELETE FROM snapshots
      WHERE device_id = ${deviceId}
        AND id NOT IN (
          SELECT id FROM snapshots
          WHERE device_id = ${deviceId}
          ORDER BY captured_at DESC
          LIMIT ${keepCount}
        )
    `;
  }
}
