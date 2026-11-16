import type { AccountDevice, Device } from '@vaulttabs/shared';
import type { Sql } from '../db/client.js';

// Every statement is scoped by user_id: a device that belongs to someone else behaves exactly
// like one that does not exist, and no statement can ever change a row's user_id.

export class DeviceRepository {
  constructor(private readonly sql: Sql) {}

  async listByUser(userId: string): Promise<Device[]> {
    return this.sql<Device[]>`
      SELECT id, user_id, device_name, last_seen, created_at
      FROM devices WHERE user_id = ${userId}
      ORDER BY last_seen DESC
    `;
  }

  async findOwned(userId: string, id: string): Promise<Device | undefined> {
    const [device] = await this.sql<Device[]>`
      SELECT id, user_id, device_name, last_seen, created_at
      FROM devices WHERE id = ${id} AND user_id = ${userId}
    `;
    return device;
  }

  /** Refresh last_seen (and optionally the name) of one of the caller's devices. */
  async touchOwned(userId: string, id: string, deviceName?: string): Promise<Device | undefined> {
    const [device] = await this.sql<Device[]>`
      UPDATE devices
      SET device_name = COALESCE(${deviceName ?? null}::text, device_name), last_seen = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, user_id, device_name, last_seen, created_at
    `;
    return device;
  }

  /**
   * Create a device with a server-generated id, unless the user already has `maxDevices`.
   * The user row lock serializes concurrent registrations so the limit cannot be raced.
   */
  async createWithinLimit(userId: string, deviceName: string, maxDevices: number): Promise<Device | null> {
    return this.sql.begin(async tx => {
      await tx`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
      const [counted] = await tx<
        { n: number }[]
      >`SELECT COUNT(*)::int AS n FROM devices WHERE user_id = ${userId}`;
      const n = counted?.n ?? 0;
      if (n >= maxDevices) return null;
      const [device] = await tx<Device[]>`
        INSERT INTO devices (user_id, device_name)
        VALUES (${userId}, ${deviceName})
        RETURNING id, user_id, device_name, last_seen, created_at
      `;
      return device ?? null;
    });
  }

  async rename(userId: string, id: string, deviceName: string): Promise<Device | undefined> {
    const [device] = await this.sql<Device[]>`
      UPDATE devices SET device_name = ${deviceName}
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, user_id, device_name, last_seen, created_at
    `;
    return device;
  }

  async deleteOwned(userId: string, id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM devices WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
  }

  async listWithStats(userId: string): Promise<AccountDevice[]> {
    return this.sql<AccountDevice[]>`
      SELECT
        d.id, d.user_id, d.device_name, d.last_seen, d.created_at,
        COALESCE(s.snapshot_count, 0)::int AS snapshot_count,
        s.last_snapshot_at
      FROM devices d
      LEFT JOIN (
        SELECT device_id, COUNT(*) AS snapshot_count, MAX(captured_at) AS last_snapshot_at
        FROM snapshots WHERE user_id = ${userId}
        GROUP BY device_id
      ) s ON s.device_id = d.id
      WHERE d.user_id = ${userId}
      ORDER BY d.last_seen DESC
    `;
  }
}
