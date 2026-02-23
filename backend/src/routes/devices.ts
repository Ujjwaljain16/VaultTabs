import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Container } from '../container.js';
import { authenticate } from '../middleware/auth.js';

const RegisterDeviceSchema = z.object({
  device_name: z.string()
    .min(1, 'device_name is required')
    .max(100, 'device_name must be under 100 characters'),
  fingerprint: z.string().optional(),
});

type RegisterDeviceBody = z.infer<typeof RegisterDeviceSchema>;

export async function deviceRoutes(fastify: FastifyInstance, options: { container: Container }) {
  const { deviceService } = options.container;

  fastify.post<{ Body: RegisterDeviceBody }>('/devices/register', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;

    const parseResult = RegisterDeviceSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.flatten().fieldErrors,
      });
    }

    const { device_name, fingerprint } = parseResult.data;
    const device = await deviceService.registerDevice(userId, device_name, fingerprint);

    return reply.status(201).send({
      message: 'Device registered',
      device
    });
  });

  fastify.get('/devices', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const devices = await deviceService.listDevices(userId);
    return reply.send({ devices });
  });

  fastify.patch<{ Params: { id: string } }>('/devices/:id/heartbeat', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id: deviceId } = request.params;

    try {
      await deviceService.heartbeat(userId, deviceId);
      return reply.send({ message: 'Heartbeat received' });
    } catch (err) {
      return reply.status(404).send({ error: 'Device not found' });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/devices/:id', {
    preHandler: [authenticate],
  }, async (request, reply) => {
    const { userId } = request.user;
    const { id: deviceId } = request.params;

    try {
      await deviceService.deleteDevice(userId, deviceId);
      return reply.send({ message: 'Device removed' });
    } catch (err) {
      return reply.status(404).send({ error: 'Device not found' });
    }
  });

}
