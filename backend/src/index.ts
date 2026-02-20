/**
 * src/index.ts
 *
 * Unified HTTPS-enabled VaultTabs backend.
 * - Uses mkcert certificates
 * - Works over LAN (0.0.0.0)
 * - Includes all routes
 * - Clean startup banner
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
import { restoreRoutes } from './routes/restore.js';

// ─────────────────────────────────────────────────────────────
// ESM __dirname Fix
// ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────────────────────
// CERTIFICATE CONFIG (mkcert)
// ─────────────────────────────────────────────────────────────

const certDir = path.resolve(__dirname, '../../certs');

// Dynamically find mkcert files
const files = fs.readdirSync(certDir).sort(); // Sort to be deterministic
const hostIp = process.env.PUBLIC_IP || '';

// Try to find certs matching the current IP first, then fallback to any pem
const keyFile = files.find(f => f.includes('key.pem') && (hostIp && f.startsWith(hostIp))) ||
  files.find(f => f.includes('key.pem')) || 'key.pem';
const certFile = files.find(f => f.includes('.pem') && !f.includes('key.pem') && (hostIp && f.startsWith(hostIp))) ||
  files.find(f => f.includes('.pem') && !f.includes('key.pem')) || 'cert.pem';

const keyPath = path.join(certDir, keyFile);
const certPath = path.join(certDir, certFile);

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

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('\n❌ HTTPS certificates not found.');
  console.error(`Expected certs in: ${certDir}`);
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
    origin:
      process.env.NODE_ENV === 'production'
        ? (process.env.ALLOWED_ORIGINS || '')
          .split(',')
          .map(o => o.trim())
          .filter(Boolean)
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
  await server.register(restoreRoutes, { prefix: '/api/v1' });

  // ── HEALTH CHECK ───────────────────────────────────────────

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  // ── GLOBAL ERROR HANDLER ───────────────────────────────────

  server.setErrorHandler(async (error, _request, reply) => {
    console.error('[VaultTabs] Unhandled error:', error);

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error:
        statusCode === 500 ? 'Internal server error' : error.message,
      message:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Something went wrong. Check server logs.',
    });
  });

  // ── 404 HANDLER ────────────────────────────────────────────

  server.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      error: 'Not found',
      message: `Route ${request.method} ${request.url} does not exist`,
      hint: 'Check API documentation.',
    });
  });

  return server;
}

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

try {
  const server = await buildServer();
  await server.listen({ port: PORT, host: HOST });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   🔒 VaultTabs Backend (HTTPS) Running  ║');
  console.log('╠══════════════════════════════════════════╣');
  const displayHost = process.env.PUBLIC_IP || 'localhost';
  console.log(`║   https://${displayHost}:${PORT}          ║`);
  console.log(`║   https://${displayHost}:${PORT}/health   ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   Routes:                                ║');
  console.log('║   POST /api/v1/auth/register             ║');
  console.log('║   POST /api/v1/auth/login                ║');
  console.log('║   GET  /api/v1/auth/me                   ║');
  console.log('║   POST /api/v1/devices/register          ║');
  console.log('║   POST /api/v1/snapshots                 ║');
  console.log('║   POST /api/v1/restore                   ║');
  console.log('╚══════════════════════════════════════════╝\n');
} catch (err) {
  console.error('\n❌ Failed to start server:', err);
  console.error('\nCommon causes:');
  console.error('  - Port already in use → change PORT in .env');
  console.error('  - Missing .env file');
  console.error('  - Database not running');
  console.error('  - mkcert certificates missing');
  process.exit(1);
}
