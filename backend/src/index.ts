/**
 * src/index.ts
 * Unified HTTPS-enabled VaultTabs backend.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/devices.js';
import { snapshotRoutes } from './routes/snapshots.js';
import { restoreRoutes } from './routes/restore.js';
import { accountRoutes } from './routes/account.js';
import { createContainer } from './container.js';
import { runCleanup } from './db/cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// HTTPS config (disable on platforms like Render where SSL terminates at proxy)
const isRender = process.env.RENDER === 'true';
const HTTPS_ENABLED = !isRender && process.env.HTTPS_ENABLED !== 'false';

let httpsOptions: { key: Buffer; cert: Buffer } | undefined;

if (HTTPS_ENABLED) {
  const certDir = path.resolve(__dirname, '../../certs');
  const files = fs.readdirSync(certDir).sort();
  const hostIp = process.env.PUBLIC_IP || '';

  const keyFile = files.find(f => f.includes('key.pem') && (hostIp && f.startsWith(hostIp))) ||
    files.find(f => f.includes('key.pem')) || 'key.pem';
  const certFile = files.find(f => f.includes('.pem') && !f.includes('key.pem') && (hostIp && f.startsWith(hostIp))) ||
    files.find(f => f.includes('.pem') && !f.includes('key.pem')) || 'cert.pem';

  const keyPath = path.join(certDir, keyFile);
  const certPath = path.join(certDir, certFile);

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error('\n[!] HTTPS certificates not found. Set HTTPS_ENABLED=false or add certs.');
    console.error(`Expected certs in: ${certDir}`);
    process.exit(1);
  }

  httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

if (!process.env.JWT_SECRET) {
  console.error('\n[!] JWT_SECRET is not set. Generate one:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('\n[!] DATABASE_URL is not set in .env');
  process.exit(1);
}

async function buildServer() {
  const server = Fastify({
    ...(httpsOptions ? { https: httpsOptions } : {}),
    logger: {
      level: 'info',
      ...(process.env.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
    bodyLimit: 1_048_576,
  });

  await server.register(helmet, {
    contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  await server.register(cors, {
    origin: (origin, cb) => {
      if (!origin || process.env.NODE_ENV !== 'production') {
        cb(null, true);
        return;
      }
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed.includes('*')) {
          const regex = new RegExp('^' + allowed.replace(/\*/g, '.*') + '$');
          return regex.test(origin);
        }
        return allowed === origin;
      });

      if (isAllowed) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'), false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  await server.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      request.headers['x-forwarded-for'] as string || request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: 'Too many requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: context.ttl,
    }),
  });

  await server.register(jwt, {
    secret: process.env.JWT_SECRET as string,
  });

  const container = createContainer(server);

  await server.register(authRoutes, { prefix: '/api/v1', container });
  await server.register(deviceRoutes, { prefix: '/api/v1', container });
  await server.register(snapshotRoutes, { prefix: '/api/v1', container });
  await server.register(restoreRoutes, { prefix: '/api/v1', container });
  await server.register(accountRoutes, { prefix: '/api/v1', container });

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.4.0',
  }));

  server.setErrorHandler(async (error, _request, reply) => {
    console.error('[VaultTabs] Unhandled error:', error.message);
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too many requests',
        message: error.message,
      });
    }
    const status = error.statusCode || 500;
    return reply.status(status).send({
      error: status === 500 ? 'Internal server error' : error.message,
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong.',
    });
  });

  server.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      error: 'Not found',
      message: `${request.method} ${request.url} does not exist`,
    });
  });

  return server;
}

const PORT = parseInt(process.env.PORT || '3000', 10);

(async () => {
  try {
    const server = await buildServer();
    await server.listen({ port: PORT, host: '0.0.0.0' });

    console.log('\n========================================');
    console.log('  [ VaultTabs Backend v0.4.0 ]          ');
    console.log('========================================');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://localhost:${PORT}/health`);
    console.log('========================================\n');

    // Run cleanup on startup, then every hour
    runCleanup();
    setInterval(runCleanup, 60 * 60 * 1000);

  } catch (err) {
    console.error('\n[!] Failed to start server:', err);
    process.exit(1);
  }
})();


