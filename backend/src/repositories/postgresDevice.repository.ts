import { IDeviceRepository } from '../interfaces/device.repository.js';
import { Device } from '../interfaces/models.js';
import sql from '../db/client.js';

export class PostgresDeviceRepository implements IDeviceRepository {
  async findByUserId(userId: string): Promise<Device[]> {
    return await sql<Device[]>`
      SELECT * FROM devices WHERE user_id = ${userId}
      ORDER BY last_seen DESC
    `;
  }

  async findByDeviceId(deviceId: string): Promise<Device | undefined> {
    const [device] = await sql<Device[]>`
      SELECT * FROM devices WHERE id = ${deviceId} LIMIT 1
    `;
    return device;
  }

  async findByFingerprint(userId: string, fingerprint: string): Promise<Device | undefined> {
    const [device] = await sql<Device[]>`
      SELECT * FROM devices WHERE user_id = ${userId} AND fingerprint = ${fingerprint} LIMIT 1
    `;
    return device;
  }

  async getDevicesWithStats(userId: string): Promise<any[]> {
    return await sql<any[]>`
      SELECT
        d.id,
        d.device_name,
        d.last_seen,
        d.created_at,
        COUNT(s.id) AS snapshot_count,
        MAX(s.captured_at) AS last_snapshot_at
      FROM devices d
      LEFT JOIN snapshots s ON s.device_id = d.id
      WHERE d.user_id = ${userId}
      GROUP BY d.id, d.device_name, d.last_seen, d.created_at
      ORDER BY d.last_seen DESC
    `;
  }

  async upsert(device: Omit<Device, 'created_at'>): Promise<Device> {
    const [upserted] = await sql<Device[]>`
          INSERT INTO devices (id, user_id, device_name, fingerprint, last_seen)
          VALUES (${device.id}, ${device.user_id}, ${device.device_name}, ${device.fingerprint || null}, ${device.last_seen})
          ON CONFLICT (id) DO UPDATE SET
            device_name = EXCLUDED.device_name,
            fingerprint = EXCLUDED.fingerprint,
            last_seen   = EXCLUDED.last_seen
          RETURNING *
        `;
    return upserted;
  }

  async delete(deviceId: string): Promise<void> {
    await sql`
      DELETE FROM devices WHERE id = ${deviceId}
    `;
  }
}
