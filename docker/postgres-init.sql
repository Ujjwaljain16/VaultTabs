-- docker/postgres-init.sql
-- Runs once on first container startup, before migrations.
-- Creates any extensions that migrations depend on.

-- gen_random_uuid() requires pgcrypto (built into Postgres 13+)
-- but explicitly enabling it ensures compatibility
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- pg_stat_statements for query performance monitoring (optional but useful)
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";