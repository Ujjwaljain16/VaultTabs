import { IUserRepository } from '../interfaces/user.repository.js';
import { User } from '../interfaces/models.js';
import sql from '../db/client.js';

export class PostgresUserRepository implements IUserRepository {
  async findByEmail(email: string): Promise<User | undefined> {
    const [user] = await sql<User[]>`
      SELECT 
        id, email, password_hash, encrypted_master_key, master_key_iv, salt,
        recovery_encrypted_master_key, recovery_key_iv, recovery_key_salt, recovery_key_hash,
        snapshot_retention, created_at, updated_at
      FROM users WHERE email = ${email} LIMIT 1
    `;
    return user;
  }

  async findById(id: string): Promise<User | undefined> {
    const [user] = await sql<User[]>`
      SELECT * FROM users WHERE id = ${id} LIMIT 1
    `;
    return user;
  }

  async create(user: Omit<User, 'id' | 'created_at'>): Promise<User> {
    const [newUser] = await sql<User[]>`
      INSERT INTO users (
        email,
        password_hash,
        encrypted_master_key,
        master_key_iv,
        salt,
        recovery_encrypted_master_key,
        recovery_key_iv,
        recovery_key_salt,
        recovery_key_hash
      ) VALUES (
        ${user.email},
        ${user.password_hash},
        ${user.encrypted_master_key},
        ${user.master_key_iv},
        ${user.salt},
        ${user.recovery_encrypted_master_key || null},
        ${user.recovery_key_iv || null},
        ${user.recovery_key_salt || null},
        ${user.recovery_key_hash || null}
      )
      RETURNING *
    `;
    return newUser;
  }
  async updateRetention(id: string, retention: number): Promise<void> {
    await sql`
      UPDATE users SET snapshot_retention = ${retention}, updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    await sql`DELETE FROM users WHERE id = ${id}`;
  }

  async getStats(id: string): Promise<any> {
    const [stats] = await sql<any[]>`
      SELECT
        COUNT(DISTINCT d.id)  AS device_count,
        COUNT(s.id)           AS snapshot_count,
        MAX(s.captured_at)    AS last_sync_at
      FROM devices d
      LEFT JOIN snapshots s ON s.user_id = ${id}
      WHERE d.user_id = ${id}
    `;
    return stats;
  }

  async updateSecurityParams(email: string, params: {
    password_hash: string;
    encrypted_master_key: string;
    master_key_iv: string;
    salt: string;
  }): Promise<void> {
    await sql`
      UPDATE users
      SET 
        password_hash = ${params.password_hash},
        encrypted_master_key = ${params.encrypted_master_key},
        master_key_iv = ${params.master_key_iv},
        salt = ${params.salt},
        recovery_encrypted_master_key = NULL,
        recovery_key_iv = NULL,
        recovery_key_salt = NULL,
        recovery_key_hash = NULL
      WHERE email = ${email}
    `;
  }
}
