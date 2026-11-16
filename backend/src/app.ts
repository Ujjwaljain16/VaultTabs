// buildServer(config) assembles the Fastify app without listening, so tests can drive it with
// `server.inject()` (or `server.listen({ port: 0 })`) against a throwaway database.

import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.js';
import { createContainer } from './container.js';
import { createSql, type Sql } from './db/client.js';
import { defaultCode, HttpError, statusText } from './errors.js';
import { REDACT_PATHS } from './logger.js';
import { createAuthenticate } from './middleware/auth.js';
import { createOriginChecker } from './middleware/cors.js';
import { apiRoutes } from './routes/index.js';
import type { TokenClaims } from './services/auth.service.js';
import { VERSION } from './version.js';

export const API_PREFIX = '/api/v1';

export interface BuildServerOptions {
  /** Use an existing pool (the caller ends it). Otherwise one is created and ended on close. */
  sql?: Sql;
}

export async function buildServer(
  config: Config,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const usePretty = config.nodeEnv === 'development';
  const server = Fastify({
    ...(config.tls
      ? { https: { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) } }
      : {}),
    logger: {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      ...(usePretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    },
    bodyLimit: 256 * 1024,
    trustProxy: config.trustProxy,
    // Abort clients that never finish sending the request (SSE responses are unaffected).
    requestTimeout: 60_000,
    forceCloseConnections: 'idle',
  }) as unknown as FastifyInstance;

  const sql = options.sql ?? createSql(config);
  if (!options.sql) server.addHook('onClose', async () => sql.end({ timeout: 5 }));

  // ── Errors (set before any plugin/route so every context inherits them) ─────────────────────
  server.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply
        .status(status)
        .send({ error: statusText(status), message: 'Something went wrong.', code: defaultCode(status) });
    }

    if (error instanceof HttpError) {
      return reply.status(status).send({
        error: statusText(status),
        message: error.message,
        code: error.code,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }

    // Fastify's own 4xx (malformed JSON, body too large, unsupported content type, ...).
    const isValidation = 'validation' in error && Boolean(error.validation);
    return reply.status(status).send({
      error: statusText(status),
      message: error.message,
      code: isValidation ? 'validation_failed' : defaultCode(status),
    });
  });

  server.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: statusText(404),
      message: `Route ${request.method} ${request.url.split('?')[0]} not found`,
      code: 'not_found',
    }),
  );

  // ── Plugins ─────────────────────────────────────────────────────────────────────────────────
  await server.register(helmet, {
    contentSecurityPolicy: config.isProduction ? undefined : false,
    hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  const isOriginAllowed = createOriginChecker(config.allowedOrigins, config.isProduction);
  await server.register(cors, {
    // Disallowed origins simply get no CORS headers (the browser blocks the response).
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600,
  });

  await server.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // request.ip honours X-Forwarded-For only when TRUST_PROXY=true.
    keyGenerator: request => request.ip,
    errorResponseBuilder: (_request, context) =>
      new HttpError(
        context.statusCode,
        `Too many requests. Try again in ${Math.max(1, Math.ceil(context.ttl / 1000))} seconds.`,
        'rate_limited',
      ),
  });

  await server.register(jwt, {
    secret: config.jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: config.jwtExpiry },
    verify: { algorithms: ['HS256'] },
  });

  // ── Services & routes ───────────────────────────────────────────────────────────────────────
  const container = createContainer({
    config,
    sql,
    log: server.log,
    signToken: (claims: TokenClaims) => server.jwt.sign(claims),
  });
  const authenticate = createAuthenticate(container.userRepository);

  server.addHook('onReady', async () => container.restoreNotifier.start());
  server.addHook('preClose', async () => container.restoreNotifier.stop());

  await server.register(apiRoutes, { prefix: API_PREFIX, container, authenticate, isOriginAllowed });

  // ── Health ──────────────────────────────────────────────────────────────────────────────────
  /** Liveness: the process is up. */
  server.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', version: VERSION }));

  /** Readiness: the database answers. */
  server.get('/ready', { config: { rateLimit: false } }, async (request, reply) => {
    try {
      await sql`SELECT 1`;
      return { status: 'ready', version: VERSION };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply
        .status(503)
        .send({ error: statusText(503), message: 'Database unavailable', code: 'not_ready' });
    }
  });

  return server;
}
