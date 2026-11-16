import type { FastifyInstance } from 'fastify';
import { accountRoutes } from './account.js';
import { authRoutes } from './auth.js';
import type { RouteDeps } from './common.js';
import { deviceRoutes } from './devices.js';
import { restoreRoutes } from './restore.js';
import { snapshotRoutes } from './snapshots.js';

export async function apiRoutes(fastify: FastifyInstance, options: RouteDeps) {
  // Pass only the dependencies on (never `prefix`, which would be applied twice).
  const deps: RouteDeps = {
    container: options.container,
    authenticate: options.authenticate,
    isOriginAllowed: options.isOriginAllowed,
  };
  await fastify.register(authRoutes, deps);
  await fastify.register(deviceRoutes, deps);
  await fastify.register(snapshotRoutes, deps);
  await fastify.register(restoreRoutes, deps);
  await fastify.register(accountRoutes, deps);
}
