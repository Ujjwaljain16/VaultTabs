/**
 * src/db/client.ts
 *
 * This file creates the database connection.
 *
 * WHAT IS HAPPENING:
 * - We import the `postgres` library (it's the driver that lets Node.js talk to PostgreSQL)
 * - We read DATABASE_URL from your .env file
 * - We create one connection pool that the whole app shares
 * - We export `sql` — a tagged template function you use like:
 *     const rows = await sql`SELECT * FROM users WHERE email = ${email}`
 *   (The library automatically sanitizes inputs to prevent SQL injection)
 */

import postgres from 'postgres';
import 'dotenv/config'; // Load .env file automatically


// Check that DATABASE_URL is set — fail early with a clear message
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set in your .env file.\n' +
    'Copy .env.example to .env and fill in your PostgreSQL connection string.'
  );
}

// Create the SQL client (connection pool)
// `postgres` library automatically handles connection pooling
export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  debug: process.env.NODE_ENV === 'development',

  // ALWAYS enable SSL for Neon
  ssl: {
    rejectUnauthorized: false,
  },
});

// Export the SQL client
export default sql;