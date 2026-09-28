// Configures the connection pool to PostgreSQL securely utilizing postgres.js

import postgres from 'postgres';
import 'dotenv/config'; // Load .env file automatically

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set in your .env file.\n' +
    'Copy .env.example to .env and fill in your PostgreSQL connection string.'
  );
}

// Create the SQL client (connection pool)
// `postgres` library automatically handles connection pooling

// TLS to Postgres.
//   DATABASE_SSL=require   (default) TLS with certificate verification (Neon, Railway, RDS, ...)
//   DATABASE_SSL=insecure  TLS but do NOT verify the server certificate (self-signed DBs only;
//                          vulnerable to man-in-the-middle - avoid on untrusted networks)
//   DATABASE_SSL=disable   no TLS (only for a database on the same private/Docker network)
const dbSsl = (process.env.DATABASE_SSL || 'require').toLowerCase();
const ssl =
  dbSsl === 'disable' ? false :
  dbSsl === 'insecure' ? { rejectUnauthorized: false } :
  { rejectUnauthorized: true };

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  debug: process.env.NODE_ENV === 'development',
  ssl,
});

export default sql;