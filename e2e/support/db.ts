/** Direct SQL access to the e2e database, for assertions and for seeding legacy data. */

import postgres from 'postgres';
import { assertLocalDatabase, databaseUrl } from './env';

let sql: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (!sql) {
    assertLocalDatabase();
    sql = postgres(databaseUrl(), { max: 2, idle_timeout: 5, onnotice: () => {} });
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  const s = sql;
  sql = null;
  await s?.end({ timeout: 5 });
}

export async function userId(email: string): Promise<string> {
  const [row] = await db()<{ id: string }[]>`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

export async function devices(email: string): Promise<{ id: string; device_name: string }[]> {
  return db()<{ id: string; device_name: string }[]>`
    SELECT d.id, d.device_name FROM devices d JOIN users u ON u.id = d.user_id
    WHERE u.email = ${email.toLowerCase()} ORDER BY d.created_at`;
}

export async function snapshotCount(email: string, deviceName?: string): Promise<number> {
  const [row] = await db()<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM snapshots s
    JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id
    WHERE u.email = ${email.toLowerCase()} ${deviceName ? db()`AND d.device_name = ${deviceName}` : db()``}`;
  return row?.n ?? 0;
}

/** Every text column of every row in the database, concatenated (for "no plaintext" checks). */
export async function dumpAllText(): Promise<string> {
  const tables = await db()<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = await db().unsafe(`SELECT * FROM "${table_name}"`);
    parts.push(JSON.stringify(rows));
  }
  return parts.join('\n');
}
