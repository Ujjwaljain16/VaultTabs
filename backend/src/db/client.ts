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

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  debug: process.env.NODE_ENV === 'development',

  // ALWAYS enable SSL for Neon
  ssl: {
    rejectUnauthorized: false,
  },
});

export default sql;