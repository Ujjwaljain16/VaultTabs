import type { AccountInfoResponse } from '@vaulttabs/shared';
import type { Sql } from '../db/client.js';
import type { PasswordMaterialRow, RecoveryMaterialRow, UserRow } from '../types.js';

const USER_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'encrypted_master_key',
  'master_key_iv',
  'salt',
  'recovery_encrypted_master_key',
  'recovery_key_iv',
  'recovery_key_salt',
  'recovery_key_hash',
  'snapshot_retention',
  'kdf_version',
  'kdf_iterations',
  'token_version',
  'created_at',
  'updated_at',
] as const;

export type NewUser = { email: string } & PasswordMaterialRow & RecoveryMaterialRow;

type CredentialUpdate = Partial<PasswordMaterialRow & RecoveryMaterialRow>;

export class UserRepository {
  constructor(private readonly sql: Sql) {}

  async findById(id: string): Promise<UserRow | undefined> {
    const [user] = await this.sql<UserRow[]>`SELECT ${this.sql(USER_COLUMNS)} FROM users WHERE id = ${id}`;
    return user;
  }

  /** `email` must already be normalized (trimmed, lower case). */
  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [user] = await this.sql<UserRow[]>`
      SELECT ${this.sql(USER_COLUMNS)} FROM users WHERE lower(email) = ${email}
    `;
    return user;
  }

  /** The one query every authenticated request makes (primary-key lookup). */
  async findTokenState(id: string): Promise<{ email: string; token_version: number } | undefined> {
    const [row] = await this.sql<{ email: string; token_version: number }[]>`
      SELECT email, token_version FROM users WHERE id = ${id}
    `;
    return row;
  }

  /** Returns undefined if the email is already registered. */
  async create(user: NewUser): Promise<UserRow | undefined> {
    const [row] = await this.sql<UserRow[]>`
      INSERT INTO users ${this.sql(user)}
      ON CONFLICT DO NOTHING
      RETURNING ${this.sql(USER_COLUMNS)}
    `;
    return row;
  }

  /**
   * Update credential columns; with `revokeSessions` also bump token_version so every token issued
   * so far stops working.
   */
  async updateCredentials(
    id: string,
    fields: CredentialUpdate,
    options: { revokeSessions: boolean },
  ): Promise<UserRow | undefined> {
    const bump = options.revokeSessions ? 1 : 0;
    const keys = Object.keys(fields) as (keyof CredentialUpdate)[];
    const [row] = keys.length
      ? await this.sql<UserRow[]>`
          UPDATE users
          SET ${this.sql(fields, keys)}, token_version = token_version + ${bump}, updated_at = NOW()
          WHERE id = ${id}
          RETURNING ${this.sql(USER_COLUMNS)}
        `
      : await this.sql<UserRow[]>`
          UPDATE users SET token_version = token_version + ${bump}, updated_at = NOW()
          WHERE id = ${id}
          RETURNING ${this.sql(USER_COLUMNS)}
        `;
    return row;
  }

  async updateRetention(id: string, retention: number): Promise<void> {
    await this.sql`UPDATE users SET snapshot_retention = ${retention}, updated_at = NOW() WHERE id = ${id}`;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql`DELETE FROM users WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async getStats(id: string): Promise<AccountInfoResponse['stats']> {
    const [stats] = await this.sql<AccountInfoResponse['stats'][]>`
      SELECT
        (SELECT COUNT(*)::int FROM devices WHERE user_id = ${id})                         AS device_count,
        (SELECT COUNT(*)::int FROM snapshots WHERE user_id = ${id})                       AS snapshot_count,
        (SELECT COUNT(*)::int FROM snapshots WHERE user_id = ${id} AND pinned)            AS saved_count,
        (SELECT COALESCE(SUM(size_bytes), 0)::float8 FROM snapshots WHERE user_id = ${id}) AS storage_bytes,
        (SELECT MAX(captured_at) FROM snapshots WHERE user_id = ${id})                    AS last_sync_at
    `;
    return stats!;
  }
}
