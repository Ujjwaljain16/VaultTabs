import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../errors.js';
import { deviceName, idParam, type RouteDeps } from './common.js';

// Unknown fields (e.g. `fingerprint` from old extensions) are ignored. A malformed `id` is treated
// like an unknown one: a new device is created.
const RegisterDeviceBody = z.object({ device_name: deviceName, id: z.string().max(64).optional() });

export async function deviceRoutes(fastify: FastifyInstance, { container, authenticate }: RouteDeps) {
  const { deviceService } = container;

  fastify.post('/devices/register', { preHandler: authenticate }, async (request, reply) => {
    const body = parseOrThrow(RegisterDeviceBody, request.body);
    const device = await deviceService.register(request.user.userId, body.device_name, body.id);
    return reply.status(201).send({ device });
  });

  fastify.get('/devices', { preHandler: authenticate }, async request => ({
    devices: await deviceService.list(request.user.userId),
  }));

  fastify.patch('/devices/:id/heartbeat', { preHandler: authenticate }, async request => {
    await deviceService.heartbeat(request.user.userId, idParam(request.params, 'Device'));
    return { ok: true };
  });

  fastify.delete('/devices/:id', { preHandler: authenticate }, async request => {
    await deviceService.remove(request.user.userId, idParam(request.params, 'Device'));
    return { message: 'Device and its snapshots were deleted.' };
  });
}
