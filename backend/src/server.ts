// Production entry point: load config, listen, schedule cleanup, shut down gracefully.
// Migrations run before this (see package.json "start" and the Dockerfile CMD).

import 'dotenv/config'; // never overrides variables that are already set
import { buildServer } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { runCleanup } from './db/cleanup.js';
import { createSql } from './db/client.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const sql = createSql(config);
  const server = await buildServer(config, { sql });

  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupRunning: Promise<unknown> | undefined;
  const cleanup = () => {
    if (cleanupRunning) return;
    cleanupRunning = runCleanup(sql, server.log)
      .catch((err: unknown) => server.log.error({ err }, 'cleanup failed'))
      .finally(() => (cleanupRunning = undefined));
  };

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      server.log.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      if (cleanupTimer) clearInterval(cleanupTimer);
      await server.close();
      await cleanupRunning;
      await sql.end({ timeout: 5 });
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (err) {
    server.log.fatal({ err }, 'failed to start');
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  }
  server.log.info(
    { version: VERSION, tls: Boolean(config.tls), env: config.nodeEnv },
    'VaultTabs backend started',
  );

  if (config.cleanupIntervalMinutes > 0) {
    cleanup();
    cleanupTimer = setInterval(cleanup, config.cleanupIntervalMinutes * 60_000);
    cleanupTimer.unref();
  }
}

void main();
