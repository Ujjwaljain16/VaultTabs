/**
 * src/index.ts
 *
 * HTTPS-enabled VaultTabs backend using mkcert.
 * Runs securely over LAN for mobile testing.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { snapshotRoutes } from './routes/snapshots.js';

// ─────────────────────────────────────────────────────────────
// ESM __dirname Fix
// ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cert path (../../certs from backend/src)
const certDir = path.resolve(__dirname, '../../certs');
const keyPath = path.join(certDir, '100.129.162.183+2-key.pem');
const certPath = path.join(certDir, '100.129.162.183+2.pem');

// ─────────────────────────────────────────────────────────────
// ENVIRONMENT CHECKS
// ─────────────────────────────────────────────────────────────

if (!process.env.JWT_SECRET) {
  console.error('\n❌ JWT_SECRET is not set in your .env file.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('\n❌ DATABASE_URL is not set in your .env file.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// BUILD SERVER
// ─────────────────────────────────────────────────────────────

async function buildServer() {
  const server = Fastify({
    https: {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    logger: {
      level: 'info',
      ...(process.env.NODE_ENV === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }),
    },
  });

  // ── CORS ───────────────────────────────────────────────────

  await server.register(cors, {
    origin: process.env.NODE_ENV === 'production'
      ? (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)
      : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // ── JWT ────────────────────────────────────────────────────

  await server.register(jwt, {
    secret: process.env.JWT_SECRET as string,
  });

  // ── ROUTES ─────────────────────────────────────────────────

  await server.register(authRoutes, { prefix: '/api/v1' });
  await server.register(deviceRoutes, { prefix: '/api/v1' });
  await server.register(snapshotRoutes, { prefix: '/api/v1' });

  // ── HEALTH ─────────────────────────────────────────────────

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  // ── ERROR HANDLER ──────────────────────────────────────────

  server.setErrorHandler(async (error, _request, reply) => {
    console.error('[VaultTabs] Unhandled error:', error);

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal server error' : error.message,
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Something went wrong.',
    });
  });

  // ── 404 HANDLER ────────────────────────────────────────────

  server.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      error: 'Not found',
      message: `Route ${request.method} ${request.url} does not exist`,
    });
  });

  return server;
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);

try {
  const server = await buildServer();
  await server.listen({ port: PORT, host: '0.0.0.0' });

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🔒 VaultTabs Backend (HTTPS) Running ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║   https://100.129.162.183:${PORT}        ║`);
  console.log(`║   https://100.129.162.183:${PORT}/health ║`);
  console.log('╚════════════════════════════════════════╝\n');
} catch (err) {
  console.error('\n❌ Failed to start server:', err);
  process.exit(1);
}
