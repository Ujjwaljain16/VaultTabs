import type { FastifyInstance } from 'fastify';
import { LIMITS } from '@vaulttabs/shared';
import { z } from 'zod';
import { parseOrThrow } from '../errors.js';
import { credential } from '../schemas.js';
import { deviceName, idParam, type RouteDeps } from './common.js';

const RetentionBody = z.object({
  retention: z
    .number({ error: 'retention is required' })
    .int()
    .min(LIMITS.minRetention, `retention must be between ${LIMITS.minRetention} and ${LIMITS.maxRetention}`)
    .max(LIMITS.maxRetention, `retention must be between ${LIMITS.minRetention} and ${LIMITS.maxRetention}`),
});
const RenameBody = z.object({ device_name: deviceName });
const DeleteAccountBody = z.object({ current: credential });

export async function accountRoutes(fastify: FastifyInstance, { container, authenticate }: RouteDeps) {
  const { accountService, authService, deviceService } = container;

  fastify.get('/account', { preHandler: authenticate }, async request =>
    accountService.info(request.user.userId),
  );

  fastify.patch('/account/retention', { preHandler: authenticate }, async request => {
    const { retention } = parseOrThrow(RetentionBody, request.body);
    await accountService.setRetention(request.user.userId, retention);
    return { retention };
  });

  fastify.get('/account/devices', { preHandler: authenticate }, async request => ({
    devices: await accountService.devicesWithStats(request.user.userId),
  }));

  fastify.patch('/account/devices/:id', { preHandler: authenticate }, async request => {
    const id = idParam(request.params, 'Device');
    const body = parseOrThrow(RenameBody, request.body);
    return { device: await deviceService.rename(request.user.userId, id, body.device_name) };
  });

  fastify.delete('/account/devices/:id', { preHandler: authenticate }, async request => {
    await deviceService.remove(request.user.userId, idParam(request.params, 'Device'));
    return { message: 'Device and its snapshots were deleted.' };
  });

  fastify.delete(
    '/account',
    { preHandler: authenticate, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async request => {
      const body = parseOrThrow(DeleteAccountBody, request.body);
      await authService.deleteAccount(request.user.userId, body.current);
      return { message: 'Your account and all of its data were permanently deleted.' };
    },
  );
}
