// postgres.js connection pool factory. No module-level state: callers own the client and must
// `await sql.end()` when done.

import postgres from 'postgres';
import type { DatabaseConfig } from '../config.js';

export type Sql = postgres.Sql;
/** Anything that can run a tagged-template query: the pool or a transaction. */
export type Queryable = postgres.ISql;
export type TransactionSql = postgres.TransactionSql;

export function createSql(config: DatabaseConfig, options: { max?: number } = {}): Sql {
  // DATABASE_SSL:
  //   require  (default) TLS with certificate verification (Neon, RDS, ...)
  //   insecure TLS without certificate verification (self-signed only; MITM-able)
  //   disable  no TLS (database on the same private/Docker network only)
  const ssl =
    config.databaseSsl === 'disable'
      ? false
      : config.databaseSsl === 'insecure'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };

  return postgres(config.databaseUrl, {
    max: options.max ?? config.databasePoolMax,
    ssl,
    idle_timeout: 60,
    connect_timeout: 15,
    // Silence NOTICE messages (e.g. "relation already exists, skipping" from IF NOT EXISTS).
    onnotice: () => {},
  });
}
